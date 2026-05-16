import assert from "node:assert/strict";
import test from "node:test";

import { WechatClawbotIlinkClient } from "./ilink-client.js";

test("iLink client sends official auth headers and normalizes text updates", async () => {
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test",
    requestTimeoutMs: 1000,
    env: { ILINK_TOKEN: "test-bot-token" },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({
        get_updates_buf: "cursor-2",
        message_list: [{
          message_id: "msg-1",
          from_user_id: "wxid_boss",
          context_token: "context-1",
          item_list: [{ type: "TEXT", text: "hello" }],
        }],
      }), { status: 200 });
    },
  });

  const result = await client.fetchUpdates({
    accountId: "acct",
    botTokenEnv: "ILINK_TOKEN",
    xWechatUin: "12345",
  }, "cursor-1");

  assert.equal(requests[0].url, "https://ilink.example.test/getupdates");
  assert.equal(requests[0].headers.get("AuthorizationType"), "ilink_bot_token");
  assert.equal(requests[0].headers.get("Authorization"), "Bearer test-bot-token");
  assert.equal(requests[0].headers.get("X-WECHAT-UIN"), "12345");
  assert.deepEqual(requests[0].body, { get_updates_buf: "cursor-1" });
  assert.equal(result.nextCursor, "cursor-2");
  assert.deepEqual(result.messages, [{
    messageId: "msg-1",
    fromUserId: "wxid_boss",
    contextToken: "context-1",
    text: "hello",
    createTimeMs: undefined,
  }]);
});

test("iLink client sends text with context token", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test/",
    requestTimeoutMs: 1000,
    env: { ILINK_TOKEN: "test-bot-token" },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  await client.sendText({ accountId: "acct", botTokenEnv: "ILINK_TOKEN" }, "context-1", "reply");

  assert.equal(requests[0].url, "https://ilink.example.test/sendmessage");
  assert.deepEqual(requests[0].body, {
    context_token: "context-1",
    item_list: [{ type: "TEXT", text: "reply" }],
  });
});
