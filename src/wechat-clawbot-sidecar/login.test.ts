import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";

import { runWechatClawbotLogin } from "./login.js";

test("wechat clawbot login renders QR, polls confirmation, writes token file and config", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clawbot-login-"));
  const configPath = path.join(dir, "sidecar.json");
  const tokenDir = path.join(dir, "tokens");
  const calls: Array<{ url: string; method?: string; headers: Headers; body?: string }> = [];
  const rendered: string[] = [];

  const result = await runWechatClawbotLogin({
    configPath,
    tokenDir,
    apiBaseUrl: "https://ilink.example.test",
    maxWaitMs: 1000,
    pollIntervalMs: 1,
    renderQr: (content) => rendered.push(content),
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (String(input).endsWith("/ilink/bot/get_bot_qrcode?bot_type=3")) {
        return new Response(JSON.stringify({
          qrcode: "qr-id",
          qrcode_img_content: "qr-content",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: "confirmed",
        bot_token: "secret-bot-token",
        ilink_bot_id: "bot_123",
        ilink_user_id: "user_123",
      }), { status: 200 });
    },
  });

  assert.equal(result.accountId, "bot_123");
  assert.equal(result.ilinkUserId, "user_123");
  assert.deepEqual(rendered, ["qr-content"]);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.get("iLink-App-Id"), "bot");
  assert.equal(calls[0].headers.get("iLink-App-ClientVersion"), "132099");
  assert.equal(calls[0].headers.get("AuthorizationType"), "ilink_bot_token");
  assert.equal(calls[0].body, JSON.stringify({ local_token_list: [] }));
  assert.equal(calls[1].url, "https://ilink.example.test/ilink/bot/get_qrcode_status?qrcode=qr-id");
  assert.equal(calls[1].headers.get("iLink-App-Id"), "bot");
  assert.equal(calls[1].headers.get("iLink-App-ClientVersion"), "132099");
  assert.equal(calls[1].headers.has("AuthorizationType"), false);

  const tokenFile = path.join(tokenDir, "bot_123.bot-token");
  assert.equal(fs.readFileSync(tokenFile, "utf8"), "secret-bot-token\n");
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(config.transport, "ilink");
  assert.deepEqual(config.ilinkAccounts, [{
    accountId: "bot_123",
    botTokenFile: tokenFile,
  }]);
  assert.equal(JSON.stringify(config).includes("secret-bot-token"), false);
});

test("wechat clawbot login fails closed when QR expires", async () => {
  await assert.rejects(
    () => runWechatClawbotLogin({
      apiBaseUrl: "https://ilink.example.test",
      maxWaitMs: 1000,
      pollIntervalMs: 1,
      renderQr() {},
      fetchImpl: async (input) => {
        if (String(input).endsWith("/ilink/bot/get_bot_qrcode?bot_type=3")) {
          return new Response(JSON.stringify({
            qrcode: "qr-id",
            qrcode_img_content: "qr-content",
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: "expired" }), { status: 200 });
      },
    }),
    /QR code expired/
  );
});
