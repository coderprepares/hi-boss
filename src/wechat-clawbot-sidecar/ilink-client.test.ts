import assert from "node:assert/strict";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";

import { WechatClawbotIlinkClient } from "./ilink-client.js";

function tempMediaDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-media-")), "media");
}

function encryptAes128Ecb(payload: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(payload), cipher.final()]);
}

test("iLink client sends official auth headers and normalizes text updates", async () => {
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test",
    cdnBaseUrl: "https://cdn.example.test/c2c",
    mediaDir: tempMediaDir(),
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

  assert.equal(requests[0].url, "https://ilink.example.test/ilink/bot/getupdates");
  assert.equal(requests[0].headers.get("AuthorizationType"), "ilink_bot_token");
  assert.equal(requests[0].headers.get("Authorization"), "Bearer test-bot-token");
  assert.equal(requests[0].headers.get("X-WECHAT-UIN"), "12345");
  assert.deepEqual(requests[0].body, {
    get_updates_buf: "cursor-1",
    base_info: {
      channel_version: "1.0.0",
    },
  });
  assert.equal(result.nextCursor, "cursor-2");
  assert.deepEqual(result.messages, [{
    messageId: "msg-1",
    fromUserId: "wxid_boss",
    contextToken: "context-1",
    text: "hello",
    createTimeMs: undefined,
  }]);
});

test("iLink client accepts numeric message ids from real iLink updates", async () => {
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test",
    cdnBaseUrl: "https://cdn.example.test/c2c",
    mediaDir: tempMediaDir(),
    requestTimeoutMs: 1000,
    env: { ILINK_TOKEN: "test-bot-token" },
    fetchImpl: async () => new Response(JSON.stringify({
      get_updates_buf: "cursor-2",
      msgs: [{
        message_id: 7461333195478521000,
        from_user_id: "wxid_boss",
        context_token: "context-1",
        item_list: [{
          type: 1,
          text_item: { text: "测试2" },
        }],
      }],
    }), { status: 200 }),
  });

  const result = await client.fetchUpdates({
    accountId: "acct",
    botTokenEnv: "ILINK_TOKEN",
  }, "cursor-1");

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].messageId, "7461333195478521000");
  assert.equal(result.messages[0].text, "测试2");
});

test("iLink client normalizes quoted message text from ref_msg", async () => {
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test",
    cdnBaseUrl: "https://cdn.example.test/c2c",
    mediaDir: tempMediaDir(),
    requestTimeoutMs: 1000,
    env: { ILINK_TOKEN: "test-bot-token" },
    fetchImpl: async () => new Response(JSON.stringify({
      get_updates_buf: "cursor-2",
      msgs: [{
        message_id: "msg-quoted",
        from_user_id: "wxid_boss",
        context_token: "context-1",
        item_list: [{
          type: 1,
          text_item: { text: "reply text" },
          ref_msg: {
            message_item: {
              type: 1,
              create_time_ms: 1779213695215,
              text_item: { text: "quoted text" },
            },
          },
        }],
      }],
    }), { status: 200 }),
  });

  const result = await client.fetchUpdates({
    accountId: "acct",
    botTokenEnv: "ILINK_TOKEN",
  }, "cursor-1");

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, "reply text");
  assert.deepEqual(result.messages[0].inReplyTo, {
    text: "quoted text",
    source_create_time_ms: 1779213695215,
    source_type: 1,
  });
});

test("iLink client traces raw message field keys without sensitive values", async () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  (process.stdout.write as any) = (chunk: unknown, ...args: unknown[]) => {
    writes.push(String(chunk));
    const callback = args.find((arg): arg is () => void => typeof arg === "function");
    callback?.();
    return true;
  };

  try {
    const client = new WechatClawbotIlinkClient({
      apiBaseUrl: "https://ilink.example.test",
      cdnBaseUrl: "https://cdn.example.test/c2c",
      mediaDir: tempMediaDir(),
      requestTimeoutMs: 1000,
      env: {
        ILINK_TOKEN: "test-bot-token",
        HIBOSS_WECHAT_CLAWBOT_TRACE_RAW_FIELDS: "true",
      },
      fetchImpl: async () => new Response(JSON.stringify({
        get_updates_buf: "cursor-2",
        msgs: [{
          message_id: "msg-quoted",
          from_user_id: "wxid_boss",
          context_token: "secret-context-token",
          item_list: [{
            type: 1,
            text_item: { text: "sensitive message body" },
            quote_item: {
              source_message_id: "quoted-message-id",
              text: "quoted sensitive text",
            },
          }],
        }],
      }), { status: 200 }),
    });

    await client.fetchUpdates({
      accountId: "acct",
      botTokenEnv: "ILINK_TOKEN",
    }, "cursor-1");
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = writes.join("");
  assert.match(output, /event=wechat-clawbot-raw-message-fields/);
  assert.match(output, /quote_item/);
  assert.match(output, /source_message_id/);
  assert.doesNotMatch(output, /secret-context-token/);
  assert.doesNotMatch(output, /sensitive message body/);
  assert.doesNotMatch(output, /quoted sensitive text/);
});

test("iLink client downloads image and file updates into local attachments", async () => {
  const mediaDir = tempMediaDir();
  const key = crypto.randomBytes(16);
  const imagePlaintext = Buffer.from("image-bytes");
  const filePlaintext = Buffer.from("file-bytes");
  const encryptedImage = encryptAes128Ecb(imagePlaintext, key);
  const encryptedFile = encryptAes128Ecb(filePlaintext, key);
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test",
    cdnBaseUrl: "https://cdn.example.test/c2c",
    mediaDir,
    requestTimeoutMs: 1000,
    env: { ILINK_TOKEN: "test-bot-token" },
    fetchImpl: async (input) => {
      const url = String(input);
      if (url === "https://cdn.example.test/image") {
        return new Response(new Uint8Array(encryptedImage), { status: 200 });
      }
      if (url === "https://cdn.example.test/file") {
        return new Response(new Uint8Array(encryptedFile), { status: 200 });
      }
      return new Response(JSON.stringify({
        get_updates_buf: "cursor-2",
        msgs: [{
          message_id: "msg-image",
          from_user_id: "wxid_boss",
          context_token: "context-1",
          item_list: [{
            type: 2,
            image_item: {
              aeskey: key.toString("hex"),
              media: { full_url: "https://cdn.example.test/image" },
            },
          }, {
            type: 4,
            file_item: {
              file_name: "report.pdf",
              media: {
                full_url: "https://cdn.example.test/file",
                aes_key: key.toString("base64"),
              },
            },
          }],
        }],
      }), { status: 200 });
    },
  });

  const result = await client.fetchUpdates({
    accountId: "acct",
    botTokenEnv: "ILINK_TOKEN",
  }, "cursor-1");

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, undefined);
  assert.equal(result.messages[0].attachments?.length, 2);
  const [image, file] = result.messages[0].attachments!;
  assert.equal(image.filename, "wechat-image-msg-image-0.jpg");
  assert.equal(fs.readFileSync(image.source, "utf8"), "image-bytes");
  assert.equal(file.filename, "report.pdf");
  assert.equal(fs.readFileSync(file.source, "utf8"), "file-bytes");
});

test("iLink client sends text with context token", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test/",
    cdnBaseUrl: "https://cdn.example.test/c2c",
    mediaDir: tempMediaDir(),
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

  await client.sendText({ accountId: "acct", botTokenEnv: "ILINK_TOKEN" }, "wxid_boss", "context-1", "reply");

  assert.equal(requests[0].url, "https://ilink.example.test/ilink/bot/sendmessage");
  assert.equal(requests[0].body.msg.to_user_id, "wxid_boss");
  assert.equal(requests[0].body.msg.context_token, "context-1");
  assert.equal(requests[0].body.msg.item_list[0].type, 1);
  assert.deepEqual(requests[0].body.msg.item_list[0].text_item, { text: "reply" });
  assert.equal(requests[0].body.base_info.channel_version, "1.0.3");
});

test("iLink client gets config and sends typing with ticket", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test/",
    cdnBaseUrl: "https://cdn.example.test/c2c",
    mediaDir: tempMediaDir(),
    requestTimeoutMs: 1000,
    env: { ILINK_TOKEN: "test-bot-token" },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({ typing_ticket: "typing-ticket-1" }), { status: 200 });
    },
  });

  const config = await client.getConfig(
    { accountId: "acct", botTokenEnv: "ILINK_TOKEN" },
    "wxid_boss",
    "context-1"
  );
  await client.sendTyping(
    { accountId: "acct", botTokenEnv: "ILINK_TOKEN" },
    "wxid_boss",
    "typing-ticket-1",
    1
  );

  assert.deepEqual(config, { typing_ticket: "typing-ticket-1" });
  assert.equal(requests[0].url, "https://ilink.example.test/ilink/bot/getconfig");
  assert.equal(requests[0].body.ilink_user_id, "wxid_boss");
  assert.equal(requests[0].body.context_token, "context-1");
  assert.equal(requests[0].body.base_info.channel_version, "1.0.0");
  assert.equal(requests[1].url, "https://ilink.example.test/ilink/bot/sendtyping");
  assert.equal(requests[1].body.ilink_user_id, "wxid_boss");
  assert.equal(requests[1].body.typing_ticket, "typing-ticket-1");
  assert.equal(requests[1].body.status, 1);
});

test("iLink client uploads and sends outbound image and file attachments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-outbound-"));
  const imagePath = path.join(dir, "image.jpg");
  const filePath = path.join(dir, "report.pdf");
  fs.writeFileSync(imagePath, "image-bytes");
  fs.writeFileSync(filePath, "file-bytes");
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
    text: "caption",
    attachments: [
      { source: imagePath, filename: "image.jpg" },
      { source: filePath, filename: "report.pdf" },
    ],
  });

  const uploadRequests = requests.filter((request) => request.url.endsWith("/ilink/bot/getuploadurl"));
  assert.equal(uploadRequests.length, 2);
  assert.equal(uploadRequests[0].body.media_type, 1);
  assert.equal(uploadRequests[1].body.media_type, 3);
  const sendRequests = requests.filter((request) => request.url.endsWith("/ilink/bot/sendmessage"));
  assert.equal(sendRequests.length, 3);
  assert.equal(sendRequests[0].body.msg.item_list[0].type, 1);
  assert.equal(sendRequests[1].body.msg.item_list[0].type, 2);
  assert.equal(sendRequests[2].body.msg.item_list[0].type, 4);
  assert.equal(sendRequests[2].body.msg.item_list[0].file_item.file_name, "report.pdf");
});
