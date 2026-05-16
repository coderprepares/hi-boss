import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";

import { WechatClawbotSidecarServer } from "../wechat-clawbot-sidecar/server.js";
import { WechatClawbotAdapter } from "./wechat-clawbot.adapter.js";
import type { ChannelMessage } from "./types.js";

function tempStateFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-e2e-")), "state.json");
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

test("wechat-clawbot adapter exchanges text with local sidecar scaffold", async () => {
  const sidecar = new WechatClawbotSidecarServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: tempStateFile(),
    transport: "mock",
    mockIngestEnabled: true,
    allowNonLocalBind: false,
    defaultAccount: "test-account",
    pollIntervalMs: 2000,
    requestTimeoutMs: 1000,
    ilinkApiBaseUrl: "https://ilink.example.test",
    ilinkAccounts: [],
  }, { apiToken: "sidecar-token" });

  await sidecar.start();
  try {
    const adapter = new WechatClawbotAdapter(JSON.stringify({
      baseUrl: sidecar.url(),
      tokenEnv: "TEST_WECHAT_CLAWBOT_SIDECAR_TOKEN",
      pollIntervalMs: 0,
      requestTimeoutMs: 1000,
    }), {
      env: {
        TEST_WECHAT_CLAWBOT_SIDECAR_TOKEN: "sidecar-token",
      },
    });

    const ingested = await fetchJson(`${sidecar.url()}/__mock/events`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sidecar-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account_id: "test-account",
        peer_id: "wxid_boss",
        peer_name: "Boss",
        message_id: "msg-1",
        text: "hello from wechat",
      }),
    });
    assert.equal(ingested.status, 201);

    const messages: ChannelMessage[] = [];
    adapter.onMessage((message) => {
      messages.push(message);
    });

    await adapter.pollOnce();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].platform, "wechat-clawbot");
    assert.equal(messages[0].chat.id, "test-account/wxid_boss");
    assert.equal(messages[0].author.id, "wxid_boss");
    assert.equal(messages[0].content.text, "hello from wechat");

    await adapter.sendMessage("test-account/wxid_boss", { text: "hello from hiboss" });

    const state = JSON.parse(fs.readFileSync((sidecar as any).config.stateFile, "utf8"));
    assert.equal(state.sent_messages.length, 1);
    assert.equal(state.sent_messages[0].account_id, "test-account");
    assert.equal(state.sent_messages[0].peer_id, "wxid_boss");
    assert.equal(state.sent_messages[0].text, "hello from hiboss");
  } finally {
    await sidecar.stop();
  }
});
