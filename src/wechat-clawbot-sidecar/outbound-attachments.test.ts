import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";

import { WechatClawbotIlinkClient } from "./ilink-client.js";

function tempMediaDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-media-")), "media");
}

test("iLink client downloads HTTP and HTTPS attachments before WeChat upload", async () => {
  const requests: Array<{ url: string; body?: any }> = [];
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test",
    cdnBaseUrl: "https://cdn.example.test/c2c",
    mediaDir: tempMediaDir(),
    requestTimeoutMs: 1000,
    env: { ILINK_TOKEN: "test-bot-token" },
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ url, body });
      if (url === "http://assets.example.test/photo") {
        return new Response("image-bytes", { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      if (url === "https://assets.example.test/clip.mp4") {
        return new Response("video-bytes", { status: 200, headers: { "content-type": "video/mp4" } });
      }
      if (url === "http://assets.example.test/report") {
        return new Response("file-bytes", { status: 200, headers: { "content-type": "application/pdf" } });
      }
      if (url.endsWith("/ilink/bot/getuploadurl")) {
        return new Response(JSON.stringify({ upload_full_url: "https://cdn.example.test/upload" }), {
          status: 200,
        });
      }
      if (url === "https://cdn.example.test/upload") {
        return new Response("", {
          status: 200,
          headers: { "x-encrypted-param": `download-param-${requests.length}` },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  await client.sendMessage({
    accountId: "acct",
    botTokenEnv: "ILINK_TOKEN",
  }, "wxid_boss", "context-1", {
    attachments: [
      { source: "http://assets.example.test/photo" },
      { source: "https://assets.example.test/clip.mp4" },
      { source: "http://assets.example.test/report" },
    ],
  });

  assert.deepEqual(
    requests.filter((request) => request.url.includes("assets.example.test")).map((request) => request.url),
    [
      "http://assets.example.test/photo",
      "https://assets.example.test/clip.mp4",
      "http://assets.example.test/report",
    ]
  );
  const uploadRequests = requests.filter((request) => request.url.endsWith("/ilink/bot/getuploadurl"));
  assert.equal(uploadRequests[0].body.media_type, 1);
  assert.equal(uploadRequests[1].body.media_type, 2);
  assert.equal(uploadRequests[2].body.media_type, 3);
  const sendRequests = requests.filter((request) => request.url.endsWith("/ilink/bot/sendmessage"));
  assert.equal(sendRequests[0].body.msg.item_list[0].type, 2);
  assert.equal(sendRequests[1].body.msg.item_list[0].type, 5);
  assert.equal(sendRequests[2].body.msg.item_list[0].type, 4);
  assert.equal(sendRequests[2].body.msg.item_list[0].file_item.file_name, "report.pdf");
});

test("iLink client rejects oversized remote attachments before download", async () => {
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test",
    cdnBaseUrl: "https://cdn.example.test/c2c",
    mediaDir: tempMediaDir(),
    requestTimeoutMs: 1000,
    env: { ILINK_TOKEN: "test-bot-token" },
    fetchImpl: async () => new Response("", {
      status: 200,
      headers: { "content-length": String(101 * 1024 * 1024) },
    }),
  });

  await assert.rejects(
    client.sendMessage({
      accountId: "acct",
      botTokenEnv: "ILINK_TOKEN",
    }, "wxid_boss", "context-1", {
      attachments: [{ source: "http://assets.example.test/too-large.bin" }],
    }),
    /too large/
  );
});
