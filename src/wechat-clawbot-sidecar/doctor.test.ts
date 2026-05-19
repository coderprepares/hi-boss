import assert from "node:assert/strict";
import test from "node:test";

import {
  formatWechatClawbotDoctorResult,
  runWechatClawbotDoctor,
} from "./doctor.js";
import type { WechatClawbotSidecarConfig } from "./types.js";

const baseConfig: WechatClawbotSidecarConfig = {
  host: "127.0.0.1",
  port: 26322,
  stateFile: "/tmp/wechat-clawbot-state.json",
  transport: "ilink",
  mockIngestEnabled: false,
  allowNonLocalBind: false,
  pollIntervalMs: 2000,
  requestTimeoutMs: 1000,
  ilinkApiBaseUrl: "https://ilink.example.test",
  ilinkAccounts: [{ accountId: "acct", botTokenEnv: "ILINK_TOKEN" }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("wechat sidecar doctor reports ok for healthy status", async () => {
  const seen: string[] = [];
  const result = await runWechatClawbotDoctor({
    config: baseConfig,
    fetchImpl: async (input) => {
      seen.push(String(input));
      if (String(input).endsWith("/healthz")) {
        return jsonResponse({ ok: true, service: "wechat-clawbot-sidecar", transport: "ilink" });
      }
      return jsonResponse({
        ok: true,
        service: "wechat-clawbot-sidecar",
        transport: "ilink",
        state: {
          accounts: 1,
          peers: 1,
          events: 9,
          next_cursor: "9",
          pending_outbox: 0,
          context_active: 1,
          context_expiring_soon: 0,
          context_expired: 0,
          next_context_expires_at: "2026-05-20T08:05:43.455Z",
        },
        ilink_poll: {
          enabled: true,
          last_started_at: "2026-05-19T12:57:09.380Z",
          last_completed_at: "2026-05-19T12:57:07.379Z",
        },
      });
    },
  });

  assert.deepEqual(seen, [
    "http://127.0.0.1:26322/healthz",
    "http://127.0.0.1:26322/status",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.issues, []);
  assert.match(formatWechatClawbotDoctorResult(result), /pending-outbox: 0/);
});

test("wechat sidecar doctor warns for queued outbox and poll errors", async () => {
  const result = await runWechatClawbotDoctor({
    config: baseConfig,
    fetchImpl: async (input) => {
      if (String(input).endsWith("/healthz")) {
        return jsonResponse({ ok: true, service: "wechat-clawbot-sidecar", transport: "ilink" });
      }
      return jsonResponse({
        ok: true,
        service: "wechat-clawbot-sidecar",
        transport: "ilink",
        state: {
          accounts: 1,
          peers: 1,
          events: 9,
          next_cursor: "9",
          pending_outbox: 2,
          context_active: 0,
          context_expiring_soon: 0,
          context_expired: 1,
        },
        ilink_poll: {
          enabled: true,
          last_error_at: "2026-05-19T12:57:09.380Z",
          last_error: "iLink HTTP 500",
        },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "warn");
  assert.deepEqual(result.issues.map((issue) => issue.name), [
    "pending-outbox",
    "context-active",
    "context-expired",
    "ilink-poll-error",
    "ilink-poll-not-started",
  ]);
  const output = formatWechatClawbotDoctorResult(result);
  assert.match(output, /issue-count: 5/);
  assert.match(output, /issue-4-message: iLink HTTP 500/);
});

test("wechat sidecar doctor errors when status leaks sensitive fields", async () => {
  const result = await runWechatClawbotDoctor({
    config: baseConfig,
    fetchImpl: async (input) => {
      if (String(input).endsWith("/healthz")) {
        return jsonResponse({ ok: true, service: "wechat-clawbot-sidecar", transport: "ilink" });
      }
      return jsonResponse({
        ok: true,
        service: "wechat-clawbot-sidecar",
        transport: "ilink",
        state: {
          accounts: 1,
          peers: 1,
          pending_outbox: 0,
          context_active: 1,
          context_token: "secret-context-token",
        },
        ilink_poll: { enabled: false },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.equal(result.issues[0].name, "status-secret-surface");
});
