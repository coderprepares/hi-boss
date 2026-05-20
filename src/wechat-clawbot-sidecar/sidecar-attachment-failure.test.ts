import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";

import { WechatClawbotSidecarServer } from "./server.js";

function tempFile(prefix: string, suffix = ""): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, `file${suffix}`);
}

test("sidecar returns upstream attachment send details", async () => {
  const stateFile = tempFile("wechat-sidecar-state-", ".json");
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-sidecar-media-"));
  const attachmentPath = tempFile("wechat-sidecar-attachment-", ".mp4");
  fs.writeFileSync(attachmentPath, "video-bytes");

  const ilinkFetchImpl = async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/ilink/bot/getupdates")) {
      return new Response(JSON.stringify({ get_updates_buf: "cursor-1", msgs: [] }), { status: 200 });
    }
    if (url.endsWith("/ilink/bot/getuploadurl")) {
      return new Response(JSON.stringify({ upload_full_url: "https://cdn.example.test/upload" }), { status: 200 });
    }
    if (url === "https://cdn.example.test/upload") {
      return new Response("", { status: 200, headers: { "x-encrypted-param": "download-param" } });
    }
    if (url.endsWith("/ilink/bot/sendmessage")) {
      return new Response(JSON.stringify({ error: "video rejected" }), { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const sidecar = new WechatClawbotSidecarServer({
    host: "127.0.0.1",
    port: 0,
    stateFile,
    mediaDir,
    transport: "ilink",
    mockIngestEnabled: true,
    allowNonLocalBind: false,
    defaultAccount: "acct",
    pollIntervalMs: 60_000,
    requestTimeoutMs: 1000,
    ilinkApiBaseUrl: "https://ilink.example.test",
    ilinkCdnBaseUrl: "https://cdn.example.test/c2c",
    ilinkAccounts: [{ accountId: "acct", botTokenEnv: "ILINK_TOKEN" }],
  }, { ilinkFetchImpl });

  process.env.ILINK_TOKEN = "test-bot-token";
  try {
    await sidecar.start();
    await fetch(`${sidecar.url()}/__mock/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peer_id: "wxid_boss", text: "activate", context_token_ref: "context-1" }),
    });
    const response = await fetch(`${sidecar.url()}/accounts/acct/peers/wxid_boss/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attachments: [{ source: attachmentPath, filename: "clip.mp4" }] }),
    });
    const body = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 502);
    assert.equal(body.error, "send-failed");
    assert.match(String(body.message), /send failed: iLink HTTP 500/);
  } finally {
    delete process.env.ILINK_TOKEN;
    await sidecar.stop().catch(() => undefined);
  }
});
