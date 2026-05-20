import assert from "node:assert/strict";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";

import { WechatClawbotIlinkClient } from "./ilink-client.js";
import { encryptAes128Ecb } from "./media.js";

function tempMediaDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-voice-")), "media");
}

test("iLink client maps voice text into message text", async () => {
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test",
    cdnBaseUrl: "https://cdn.example.test/c2c",
    mediaDir: tempMediaDir(),
    requestTimeoutMs: 1000,
    env: { ILINK_TOKEN: "test-bot-token" },
    fetchImpl: async () => new Response(JSON.stringify({
      get_updates_buf: "cursor-2",
      msgs: [{
        message_id: "msg-voice-text",
        from_user_id: "wxid_boss",
        context_token: "context-1",
        item_list: [{ type: 3, voice_item: { text: "voice transcript" } }],
      }],
    }), { status: 200 }),
  });

  const result = await client.fetchUpdates({ accountId: "acct", botTokenEnv: "ILINK_TOKEN" }, "cursor-1");

  assert.equal(result.messages[0].text, "voice transcript");
  assert.equal(result.messages[0].attachments, undefined);
});

test("iLink client downloads voice media as an attachment", async () => {
  const mediaDir = tempMediaDir();
  const key = crypto.randomBytes(16);
  const voicePlaintext = Buffer.from("silk-bytes");
  const encryptedVoice = encryptAes128Ecb(voicePlaintext, key);
  const client = new WechatClawbotIlinkClient({
    apiBaseUrl: "https://ilink.example.test",
    cdnBaseUrl: "https://cdn.example.test/c2c",
    mediaDir,
    requestTimeoutMs: 1000,
    env: { ILINK_TOKEN: "test-bot-token" },
    fetchImpl: async (input) => {
      if (String(input) === "https://cdn.example.test/voice") {
        return new Response(new Uint8Array(encryptedVoice), { status: 200 });
      }
      return new Response(JSON.stringify({
        get_updates_buf: "cursor-2",
        msgs: [{
          message_id: "msg-voice",
          from_user_id: "wxid_boss",
          context_token: "context-1",
          item_list: [{
            type: 3,
            voice_item: {
              text: "voice transcript",
              media: {
                full_url: "https://cdn.example.test/voice",
                aes_key: key.toString("base64"),
              },
            },
          }],
        }],
      }), { status: 200 });
    },
  });

  const result = await client.fetchUpdates({ accountId: "acct", botTokenEnv: "ILINK_TOKEN" }, "cursor-1");

  assert.equal(result.messages[0].text, "voice transcript");
  assert.equal(result.messages[0].attachments?.length, 1);
  const attachment = result.messages[0].attachments![0];
  assert.equal(attachment.filename, "wechat-voice-msg-voice-0.silk");
  assert.equal(fs.readFileSync(attachment.source, "utf8"), "silk-bytes");
});
