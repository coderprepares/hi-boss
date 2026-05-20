import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";

import { WechatClawbotIlinkClient } from "./ilink-client.js";

function tempMediaDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-media-")), "media");
}

test("iLink client sends text replies with ref_msg", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test",
    cdnBaseUrl: "https://cdn.example.test/c2c",
    mediaDir: tempMediaDir(),
    requestTimeoutMs: 1000,
    env: { ILINK_TOKEN: "test-bot-token" },
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  await client.sendMessage({ accountId: "acct", botTokenEnv: "ILINK_TOKEN" }, "wxid_boss", "context-1", {
    text: "bot reply",
    replyTo: {
      message_id: "msg-parent",
      create_time_ms: 1779213000000,
      text: "quoted user text",
    },
  });

  const item = requests[0].body.msg.item_list[0];
  assert.equal(item.type, 1);
  assert.deepEqual(item.text_item, { text: "bot reply" });
  assert.equal(item.ref_msg.title, "quoted user text");
  assert.equal(item.ref_msg.message_item.msg_id, undefined);
  assert.equal(item.ref_msg.message_item.is_completed, true);
  assert.equal(item.ref_msg.message_item.create_time_ms, 1779213000000);
  assert.equal(item.ref_msg.message_item.update_time_ms, 1779213000000);
  assert.deepEqual(item.ref_msg.message_item.text_item, { text: "quoted user text" });
});

test("iLink client falls back to plain text when ref_msg send fails", async () => {
  const sendBodies: any[] = [];
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test",
    cdnBaseUrl: "https://cdn.example.test/c2c",
    mediaDir: tempMediaDir(),
    requestTimeoutMs: 1000,
    env: { ILINK_TOKEN: "test-bot-token" },
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      sendBodies.push(body);
      if (sendBodies.length === 1) return new Response("bad ref", { status: 400 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  await client.sendMessage({ accountId: "acct", botTokenEnv: "ILINK_TOKEN" }, "wxid_boss", "context-1", {
    text: "bot reply",
    replyTo: { message_id: "msg-parent", text: "quoted user text" },
  });

  assert.equal(sendBodies.length, 2);
  assert.equal(sendBodies[0].msg.item_list[0].ref_msg.title, "quoted user text");
  assert.equal(sendBodies[1].msg.item_list[0].ref_msg, undefined);
  assert.deepEqual(sendBodies[1].msg.item_list[0].text_item, { text: "bot reply" });
});
