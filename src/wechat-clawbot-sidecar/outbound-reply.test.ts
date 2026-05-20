import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";

import { WechatClawbotSidecarServer } from "./server.js";
import type { WechatClawbotSidecarConfig } from "./types.js";

function tempStateFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-sidecar-")), "state.json");
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

test("sidecar resolves reply_to_message_id into outbound ref_msg", async () => {
  const previousToken = process.env.ILINK_TOKEN;
  process.env.ILINK_TOKEN = "test-bot-token";
  const sendBodies: any[] = [];
  const config: WechatClawbotSidecarConfig = {
    host: "127.0.0.1",
    port: 0,
    stateFile: tempStateFile(),
    mediaDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-media-")), "media"),
    transport: "ilink",
    mockIngestEnabled: true,
    allowNonLocalBind: false,
    defaultAccount: "acct",
    pollIntervalMs: 60000,
    requestTimeoutMs: 1000,
    ilinkApiBaseUrl: "https://ilink.example.test",
    ilinkCdnBaseUrl: "https://cdn.example.test/c2c",
    ilinkAccounts: [{ accountId: "acct", botTokenEnv: "ILINK_TOKEN" }],
  };
  const sidecar = new WechatClawbotSidecarServer(config, {
    ilinkFetchImpl: async (_input, init) => {
      sendBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  try {
    await sidecar.start();
    const parent = await fetchJson(`${sidecar.url()}/__mock/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer_id: "wxid_boss",
        message_id: "msg-parent",
        message_create_time_ms: 1779213000000,
        text: "quoted user text",
        context_token_ref: "context-1",
      }),
    });
    assert.equal(parent.status, 201);

    const sent = await fetchJson(`${sidecar.url()}/accounts/acct/peers/wxid_boss/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "bot reply",
        reply_to_message_id: parent.body.event.event_id,
      }),
    });
    assert.equal(sent.status, 200);
    assert.equal(sendBodies.length, 1);
    const item = sendBodies[0].msg.item_list[0];
    assert.equal(item.ref_msg.message_item.msg_id, "msg-parent");
    assert.deepEqual(item.ref_msg.message_item.text_item, { text: "quoted user text" });
  } finally {
    if (previousToken === undefined) delete process.env.ILINK_TOKEN;
    else process.env.ILINK_TOKEN = previousToken;
    await sidecar.stop();
  }
});
