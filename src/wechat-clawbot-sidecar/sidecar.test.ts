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
    mediaDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-media-")), "media"),
    transport: "mock",
    mockIngestEnabled: true,
    allowNonLocalBind: false,
    defaultAccount: "acct",
    pollIntervalMs: 2000,
    requestTimeoutMs: 1000,
    ilinkApiBaseUrl: "https://ilink.example.test",
    ilinkCdnBaseUrl: "https://cdn.example.test/c2c",
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

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await check(), true);
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

test("sidecar stores quoted text and matches referenced wechat events when unique", async () => {
  const sidecar = await startSidecar();
  try {
    const parent = await fetchJson(`${sidecar.url()}/__mock/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peer_id: "wxid_boss", message_id: "msg-parent", message_create_time_ms: 1779213000000, text: "quoted text" }),
    });
    assert.equal(parent.status, 201);

    const child = await fetchJson(`${sidecar.url()}/__mock/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer_id: "wxid_boss",
        message_id: "msg-child",
        text: "reply text",
        in_reply_to: { text: "quoted text", source_message_id: "msg-parent", source_create_time_ms: 1779213000000 },
      }),
    });
    assert.equal(child.status, 201);

    const updates = await fetchJson(`${sidecar.url()}/updates`);
    assert.equal(updates.body.events.length, 2);
    assert.equal(updates.body.events[1].in_reply_to.text, "quoted text");
    assert.equal(updates.body.events[1].in_reply_to.channel_message_id, updates.body.events[0].event_id);
  } finally {
    await sidecar.stop();
  }
});

test("sidecar accepts mock attachment events without text", async () => {
  const sidecar = await startSidecar();
  try {
    const ingested = await fetchJson(`${sidecar.url()}/__mock/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer_id: "wxid_boss",
        message_id: "msg-attachment",
        attachments: [{ source: "/tmp/wechat-image.jpg", filename: "wechat-image.jpg" }],
      }),
    });
    assert.equal(ingested.status, 201);

    const updates = await fetchJson(`${sidecar.url()}/updates`);
    assert.equal(updates.body.events.length, 1);
    assert.equal(updates.body.events[0].text, undefined);
    assert.deepEqual(updates.body.events[0].attachments, [{
      source: "/tmp/wechat-image.jpg",
      filename: "wechat-image.jpg",
    }]);
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

test("sidecar status exposes operational counters without message or context bodies", async () => {
  const sidecar = await startSidecar({}, "test-token");
  try {
    await fetchJson(`${sidecar.url()}/__mock/events`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        peer_id: "wxid_boss",
        message_id: "msg-status",
        text: "sensitive message body",
        context_token_ref: "secret-context-token",
      }),
    });

    const status = await fetchJson(`${sidecar.url()}/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.service, "wechat-clawbot-sidecar");
    assert.equal(status.body.transport, "mock");
    assert.equal(status.body.state.accounts, 1);
    assert.equal(status.body.state.events, 1);
    assert.equal(status.body.state.pending_outbox, 0);
    assert.equal(status.body.state.context_active, 1);

    const serialized = JSON.stringify(status.body);
    assert.equal(serialized.includes("sensitive message body"), false);
    assert.equal(serialized.includes("secret-context-token"), false);
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

test("sidecar status records the most recent iLink poll error", async () => {
  process.env.ILINK_TOKEN = "test-bot-token";
  const sidecar = await startSidecar({
    transport: "ilink",
    pollIntervalMs: 50,
    requestTimeoutMs: 1000,
    ilinkApiBaseUrl: "http://127.0.0.1:1",
    ilinkAccounts: [{ accountId: "acct", botTokenEnv: "ILINK_TOKEN" }],
  }, undefined, async () => new Response(JSON.stringify({ ok: false }), { status: 500 }));

  try {
    await waitFor(async () => {
      const status = await fetchJson(`${sidecar.url()}/status`);
      return status.body.ilink_poll.last_error === "iLink HTTP 500" &&
        status.body.ilink_poll.consecutive_failures >= 1;
    });
    const status = await fetchJson(`${sidecar.url()}/status`);
    assert.equal(status.body.ilink_poll.in_flight, false);
    assert.equal(typeof status.body.ilink_poll.last_duration_ms, "number");
    assert.ok(status.body.ilink_poll.consecutive_failures >= 1);
  } finally {
    delete process.env.ILINK_TOKEN;
    await sidecar.stop();
  }
});

test("sidecar exposes iLink getconfig and sends typing with cached ticket", async () => {
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-ilink-token-")), "token");
  fs.writeFileSync(tokenFile, "bot-token\n", { mode: 0o600 });
  const requests: Array<{ url: string; body: any }> = [];
  const sidecar = await startSidecar({
    transport: "ilink",
    pollIntervalMs: 60_000,
    ilinkAccounts: [{ accountId: "acct", botTokenFile: tokenFile }],
  }, undefined, (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ url, body });
    if (url.endsWith("/ilink/bot/getconfig")) {
      return new Response(JSON.stringify({ typing_ticket: "typing-ticket-1", mode: "test" }), { status: 200 });
    }
    if (url.endsWith("/ilink/bot/sendtyping")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ get_updates_buf: "" }), { status: 200 });
  }) as typeof fetch);
  try {
    await fetchJson(`${sidecar.url()}/__mock/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer_id: "wxid_boss",
        message_id: "msg-config",
        text: "hello",
        context_token_ref: "context-1",
      }),
    });

    const config = await fetchJson(`${sidecar.url()}/accounts/acct/peers/wxid_boss/config`);
    assert.equal(config.status, 200);
    assert.deepEqual(config.body.config, { typing_ticket: "typing-ticket-1", mode: "test" });

    const typing = await fetchJson(`${sidecar.url()}/accounts/acct/peers/wxid_boss/typing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: 1 }),
    });
    assert.equal(typing.status, 200);

    assert.equal(requests[0].url, "https://ilink.example.test/ilink/bot/getconfig");
    assert.equal(requests[0].body.ilink_user_id, "wxid_boss");
    assert.equal(requests[0].body.context_token, "context-1");
    assert.equal(requests[1].url, "https://ilink.example.test/ilink/bot/sendtyping");
    assert.equal(requests[1].body.typing_ticket, "typing-ticket-1");
    assert.equal(requests[1].body.status, 1);
  } finally {
    await sidecar.stop();
  }
});

test("sidecar iLink transport polls updates and sends through context token", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const ilinkFetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    if (String(input).endsWith("/ilink/bot/getupdates")) {
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
    await waitFor(async () => {
      const status = await fetchJson(`${sidecar.url()}/status`);
      return typeof status.body.ilink_poll.last_duration_ms === "number";
    });
    const updates = await fetchJson(`${sidecar.url()}/updates`);
    assert.equal(updates.body.events.length, 1);
    assert.equal(updates.body.events[0].peer_id, "wxid_boss");
    const status = await fetchJson(`${sidecar.url()}/status`);
    assert.equal(status.body.ilink_poll.in_flight, false);
    assert.equal(status.body.ilink_poll.consecutive_failures, 0);

    const sent = await fetchJson(`${sidecar.url()}/accounts/acct/peers/wxid_boss/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "reply" }),
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ok, true);
    assert.ok(requests.some((request) => request.url.endsWith("/ilink/bot/getupdates")));
    assert.ok(requests.some((request) => request.url.endsWith("/ilink/bot/sendmessage")));
  } finally {
    delete process.env.ILINK_TOKEN;
    await sidecar.stop();
  }
});

test("sidecar queues failed iLink sends and flushes them on next peer activation", async () => {
  const stateFile = tempStateFile();
  const requests: Array<{ url: string; body: any }> = [];
  let updateCount = 0;
  let failNextSend = true;
  let activationEnabled = false;
  const ilinkFetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ url, body });
    if (url.endsWith("/ilink/bot/getupdates")) {
      updateCount += 1;
      if (updateCount === 1) {
        return new Response(JSON.stringify({
          get_updates_buf: "cursor-1",
          msgs: [{
            message_id: 1,
            from_user_id: "wxid_boss",
            context_token: "context-1",
            item_list: [{ type: 1, text_item: { text: "hello" } }],
          }],
        }), { status: 200 });
      }
      if (activationEnabled) {
        activationEnabled = false;
        return new Response(JSON.stringify({
          get_updates_buf: "cursor-2",
          msgs: [{
            message_id: 2,
            from_user_id: "wxid_boss",
            context_token: "context-2",
            item_list: [{ type: 1, text_item: { text: "reactivate" } }],
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ get_updates_buf: `cursor-${updateCount}`, msgs: [] }), { status: 200 });
    }
    if (url.endsWith("/ilink/bot/sendmessage") && failNextSend) {
      failNextSend = false;
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  process.env.ILINK_TOKEN = "test-bot-token";
  const sidecar = await startSidecar({
    stateFile,
    transport: "ilink",
    pollIntervalMs: 50,
    requestTimeoutMs: 1000,
    ilinkApiBaseUrl: "http://127.0.0.1:1",
    ilinkAccounts: [{ accountId: "acct", botTokenEnv: "ILINK_TOKEN" }],
  }, undefined, ilinkFetchImpl);

  try {
    await waitFor(() => {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return state.peers?.[0]?.context_token_ref === "context-1";
    });

    const failed = await fetchJson(`${sidecar.url()}/accounts/acct/peers/wxid_boss/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "queued reply" }),
    });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error, "send-failed-queued");
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).pending_outbox.length, 1);

    activationEnabled = true;
    await waitFor(() => {
      const sent = requests.filter((request) => request.url.endsWith("/ilink/bot/sendmessage"));
      return sent.some((request) => request.body.msg.context_token === "context-2" && request.body.msg.item_list[0].text_item.text === "queued reply");
    });
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.pending_outbox.length, 0);
  } finally {
    delete process.env.ILINK_TOKEN;
    await sidecar.stop();
  }
});
