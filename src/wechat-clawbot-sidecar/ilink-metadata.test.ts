import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWechatIlinkBaseInfo,
  buildWechatIlinkClientVersion,
  buildWechatIlinkHeaders,
  sanitizeWechatIlinkBotAgent,
} from "./ilink-metadata.js";

test("wechat ilink metadata matches official app headers and base_info defaults", () => {
  assert.equal(buildWechatIlinkClientVersion("2.4.3"), 132099);
  assert.deepEqual(buildWechatIlinkBaseInfo(), {
    channel_version: "2.4.3",
    bot_agent: "OpenClaw",
  });

  const headers = buildWechatIlinkHeaders({
    token: " test-token ",
    xWechatUin: "fixed-uin",
  });
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("AuthorizationType"), "ilink_bot_token");
  assert.equal(headers.get("Authorization"), "Bearer test-token");
  assert.equal(headers.get("X-WECHAT-UIN"), "fixed-uin");
  assert.equal(headers.get("iLink-App-Id"), "bot");
  assert.equal(headers.get("iLink-App-ClientVersion"), "132099");
});

test("wechat ilink metadata sanitizes bot_agent with official grammar", () => {
  assert.equal(
    sanitizeWechatIlinkBotAgent("HiBoss/2026.5.20 (wechat clawbot) Bad Token OpenClaw/2.4.3"),
    "HiBoss/2026.5.20 (wechat clawbot) OpenClaw/2.4.3"
  );
  assert.equal(sanitizeWechatIlinkBotAgent("invalid"), "OpenClaw");
});

test("wechat ilink GET-style headers only include official common headers", () => {
  const headers = buildWechatIlinkHeaders({ includeContentType: false });
  assert.equal(headers.get("iLink-App-Id"), "bot");
  assert.equal(headers.get("iLink-App-ClientVersion"), "132099");
  assert.equal(headers.has("Content-Type"), false);
  assert.equal(headers.has("AuthorizationType"), false);
  assert.equal(headers.has("X-WECHAT-UIN"), false);
});
