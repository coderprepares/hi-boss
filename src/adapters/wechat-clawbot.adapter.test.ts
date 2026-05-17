import assert from "node:assert/strict";
import test from "node:test";

import { WechatClawbotAdapter } from "./wechat-clawbot.adapter.js";
import type { ChannelMessage } from "./types.js";
import { parseWechatClawbotAdapterToken } from "./wechat-clawbot/sidecar-client.js";

function makeAdapterToken(): string {
  return JSON.stringify({
    baseUrl: "http://sidecar.local",
    pollIntervalMs: 0,
    requestTimeoutMs: 1000,
  });
}

test("wechat-clawbot adapter maps sidecar text updates to ChannelMessage", async () => {
  const requests: string[] = [];
  const fetchImpl = async (input: string | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      events: [
        {
          event_id: "evt-1",
          account_id: "acct",
          peer_id: "wxid_boss",
          peer_name: "Boss",
          text: "hello",
        },
      ],
      next_cursor: "cursor-1",
    }), { status: 200 });
  };

  const adapter = new WechatClawbotAdapter(makeAdapterToken(), { fetchImpl });
  const messages: ChannelMessage[] = [];
  adapter.onMessage((message) => {
    messages.push(message);
  });

  await adapter.pollOnce();

  assert.deepEqual(requests, ["http://sidecar.local/updates"]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].platform, "wechat-clawbot");
  assert.equal(messages[0].id, "evt-1");
  assert.equal(messages[0].author.id, "wxid_boss");
  assert.equal(messages[0].author.displayName, "Boss");
  assert.equal(messages[0].chat.id, "acct/wxid_boss");
  assert.equal(messages[0].content.text, "hello");
});

test("wechat-clawbot adapter skips existing sidecar events when no stored cursor exists", async () => {
  const savedCursors: string[] = [];
  const requests: string[] = [];
  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === "http://sidecar.local/updates") {
      return new Response(JSON.stringify({
        events: [
          {
            event_id: "old-evt",
            account_id: "acct",
            peer_id: "wxid_boss",
            text: "old",
          },
        ],
        next_cursor: "1",
      }), { status: 200 });
    }
    if (requests.length === 2) {
      return new Response(JSON.stringify({
        events: [],
        next_cursor: "1",
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      events: [
        {
          event_id: "new-evt",
          account_id: "acct",
          peer_id: "wxid_boss",
          text: "new",
        },
      ],
      next_cursor: "2",
    }), { status: 200 });
  };

  const adapter = new WechatClawbotAdapter(makeAdapterToken(), {
    fetchImpl,
    cursorStore: {
      load: () => undefined,
      save: (cursor) => savedCursors.push(cursor),
    },
    skipExistingEventsOnEmptyCursor: true,
  });
  const messages: ChannelMessage[] = [];
  adapter.onMessage((message) => {
    messages.push(message);
  });

  await adapter.pollOnce();
  await adapter.pollOnce();

  assert.deepEqual(requests, [
    "http://sidecar.local/updates",
    "http://sidecar.local/updates?cursor=1",
    "http://sidecar.local/updates?cursor=1",
  ]);
  assert.deepEqual(savedCursors, ["1", "2"]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "new-evt");
  assert.equal(messages[0].content.text, "new");
});

test("wechat-clawbot adapter resumes from stored cursor on first poll", async () => {
  const savedCursors: string[] = [];
  const requests: string[] = [];
  const fetchImpl = async (input: string | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      events: [
        {
          event_id: "evt-after-restart",
          account_id: "acct",
          peer_id: "wxid_boss",
          text: "after restart",
        },
      ],
      next_cursor: "7",
    }), { status: 200 });
  };

  const adapter = new WechatClawbotAdapter(makeAdapterToken(), {
    fetchImpl,
    cursorStore: {
      load: () => "6",
      save: (cursor) => savedCursors.push(cursor),
    },
    skipExistingEventsOnEmptyCursor: true,
  });
  const messages: ChannelMessage[] = [];
  adapter.onMessage((message) => {
    messages.push(message);
  });

  await adapter.pollOnce();

  assert.deepEqual(requests, ["http://sidecar.local/updates?cursor=6"]);
  assert.deepEqual(savedCursors, ["7"]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "evt-after-restart");
});

test("wechat-clawbot adapter sends text through sidecar peer endpoint", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedBody = "";
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedMethod = init?.method ?? "";
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const adapter = new WechatClawbotAdapter(makeAdapterToken(), { fetchImpl });
  await adapter.sendMessage("acct/wxid_boss", { text: "reply" });

  assert.equal(capturedUrl, "http://sidecar.local/accounts/acct/peers/wxid_boss/messages");
  assert.equal(capturedMethod, "POST");
  assert.deepEqual(JSON.parse(capturedBody), { text: "reply" });
});

test("wechat-clawbot adapter turns sidecar slash commands into command replies", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST") {
      posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({
      events: [
        {
          event_id: "evt-command",
          account_id: "acct",
          peer_id: "wxid_boss",
          text: "/status kai",
        },
      ],
    }), { status: 200 });
  };

  const adapter = new WechatClawbotAdapter(makeAdapterToken(), { fetchImpl });
  const messages: ChannelMessage[] = [];
  adapter.onMessage((message) => {
    messages.push(message);
  });
  adapter.onCommand((command) => ({
    text: `${command.platform}:${command.command}:${command.args}:${command.authorId}`,
  }));

  await adapter.pollOnce();

  assert.equal(messages.length, 0);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "http://sidecar.local/accounts/acct/peers/wxid_boss/messages");
  assert.deepEqual(posts[0].body, { text: "wechat-clawbot:status:kai:wxid_boss" });
});

test("wechat-clawbot adapter token rejects inline secrets", () => {
  assert.throws(
    () => parseWechatClawbotAdapterToken(JSON.stringify({
      baseUrl: "http://sidecar.local",
      apiToken: "do-not-store-here",
    })),
    /store secrets in tokenEnv or tokenFile/
  );
});
