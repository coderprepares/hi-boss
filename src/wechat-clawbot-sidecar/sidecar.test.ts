import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";

import {
  loadWechatClawbotSidecarConfig,
  resolveWechatClawbotSidecarApiToken,
} from "./config.js";
import { WechatClawbotSidecarServer } from "./server.js";
import type { WechatClawbotSidecarConfig } from "./types.js";

function tempStateFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-sidecar-")), "state.json");
}

async function startSidecar(
  overrides: Partial<WechatClawbotSidecarConfig> = {},
  apiToken?: string,
  ilinkFetchImpl?: typeof fetch
): Promise<WechatClawbotSidecarServer> {
  const sidecar = new WechatClawbotSidecarServer({
    host: "127.0.0.1",
    port: 0,
    stateFile: tempStateFile(),
    transport: "mock",
    mockIngestEnabled: true,
    allowNonLocalBind: false,
    defaultAccount: "acct",
    pollIntervalMs: 2000,
    requestTimeoutMs: 1000,
    ilinkApiBaseUrl: "https://ilink.example.test",
    ilinkAccounts: [],
    ...overrides,
  }, { apiToken, ilinkFetchImpl });
  await sidecar.start();
  return sidecar;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

test("sidecar accepts mock text events, exposes cursor updates, and sends replies", async () => {
  const stateFile = tempStateFile();
  const sidecar = await startSidecar({ stateFile });
  try {
    const ingested = await fetchJson(`${sidecar.url()}/__mock/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer_id: "wxid_boss",
        peer_name: "Boss",
        message_id: "msg-1",
        text: "hello",
      }),
    });
    assert.equal(ingested.status, 201);
    assert.equal(ingested.body.duplicate, false);

    const first = await fetchJson(`${sidecar.url()}/updates`);
    assert.equal(first.status, 200);
    assert.equal(first.body.events.length, 1);
    assert.equal(first.body.events[0].account_id, "acct");
    assert.equal(first.body.events[0].peer_id, "wxid_boss");
    assert.equal(first.body.events[0].text, "hello");

    const second = await fetchJson(`${sidecar.url()}/updates?cursor=${first.body.next_cursor}`);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.events, []);

    const sent = await fetchJson(`${sidecar.url()}/accounts/acct/peers/wxid_boss/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "reply" }),
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ok, true);

    const mode = fs.statSync(stateFile).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await sidecar.stop();
  }
});

test("sidecar deduplicates stable message ids", async () => {
  const sidecar = await startSidecar();
  try {
    const body = {
      peer_id: "wxid_boss",
      message_id: "same-msg",
      text: "hello",
    };
    const first = await fetchJson(`${sidecar.url()}/__mock/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const second = await fetchJson(`${sidecar.url()}/__mock/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);

    const updates = await fetchJson(`${sidecar.url()}/updates`);
    assert.equal(updates.body.events.length, 1);
  } finally {
    await sidecar.stop();
  }
});

test("sidecar protects API routes with bearer token when configured", async () => {
  const sidecar = await startSidecar({}, "test-token");
  try {
    const unauthorized = await fetchJson(`${sidecar.url()}/updates`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetchJson(`${sidecar.url()}/updates`, {
      headers: { Authorization: "Bearer test-token" },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await sidecar.stop();
  }
});

test("sidecar resolves API token from env or token file without inline config secrets", () => {
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-token-")), "token");
  fs.writeFileSync(tokenFile, "file-token\n", { mode: 0o600 });

  assert.equal(resolveWechatClawbotSidecarApiToken({ apiTokenEnv: "SIDE_TOKEN" }, {
    SIDE_TOKEN: "env-token",
  }), "env-token");
  assert.equal(resolveWechatClawbotSidecarApiToken({ apiTokenFile: tokenFile }, {}), "file-token");
});

test("sidecar rejects inline secret and placeholder config fields", () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-config-")), "sidecar.json");
  fs.writeFileSync(configPath, JSON.stringify({
    host: "127.0.0.1",
    apiToken: "replace-me",
    contextToken: "placeholder",
  }));

  assert.throws(
    () => loadWechatClawbotSidecarConfig(configPath, {}),
    /Do not store sidecar API tokens inline/
  );
});

test("sidecar rejects inline iLink bot tokens and requires account token indirection", () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-ilink-config-")), "sidecar.json");
  fs.writeFileSync(configPath, JSON.stringify({
    transport: "ilink",
    ilinkAccounts: [{
      accountId: "acct",
      botToken: "replace-me",
    }],
  }));

  assert.throws(
    () => loadWechatClawbotSidecarConfig(configPath, {}),
    /Do not store iLink tokens inline/
  );
});

test("sidecar iLink transport polls updates and sends through context token", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const ilinkFetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    if (String(input).endsWith("/getupdates")) {
      return new Response(JSON.stringify({
        get_updates_buf: "cursor-1",
        message_list: [{
          message_id: "msg-1",
          from_user_id: "wxid_boss",
          context_token: "context-1",
          text: "hello",
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  process.env.ILINK_TOKEN = "test-bot-token";
  const sidecar = await startSidecar({
    transport: "ilink",
    pollIntervalMs: 250,
    requestTimeoutMs: 1000,
    ilinkApiBaseUrl: "http://127.0.0.1:1",
    ilinkAccounts: [{ accountId: "acct", botTokenEnv: "ILINK_TOKEN" }],
  }, undefined, ilinkFetchImpl);

  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const updates = await fetchJson(`${sidecar.url()}/updates`);
    assert.equal(updates.body.events.length, 1);
    assert.equal(updates.body.events[0].peer_id, "wxid_boss");

    const sent = await fetchJson(`${sidecar.url()}/accounts/acct/peers/wxid_boss/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "reply" }),
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ok, true);
    assert.ok(requests.some((request) => request.url.endsWith("/getupdates")));
    assert.ok(requests.some((request) => request.url.endsWith("/sendmessage")));
  } finally {
    delete process.env.ILINK_TOKEN;
    await sidecar.stop();
  }
});
