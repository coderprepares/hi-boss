import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";

import {
  formatWechatClawbotMonitorResult,
  formatWechatClawbotMonitorStatusResult,
  parseWechatClawbotMonitorCliArgs,
  parseWechatClawbotMonitorStatusCliArgs,
  runWechatClawbotMonitor,
  runWechatClawbotMonitorStatus,
} from "./monitor.js";
import type { WechatClawbotSidecarConfig } from "./types.js";

type FetchLike = NonNullable<Parameters<typeof runWechatClawbotMonitor>[0]["fetchImpl"]>;

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

function fetchWithPendingOutbox(pendingOutbox: number): FetchLike {
  return async (input) => {
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
        pending_outbox: pendingOutbox,
        sent_messages: 3,
        last_sent: { created_at: "2026-05-19T13:28:45.000Z" },
        context_active: 1,
        context_expiring_soon: 0,
        context_expired: 0,
      },
      ilink_poll: {
        enabled: true,
        last_started_at: "2026-05-19T12:57:09.380Z",
        last_completed_at: "2026-05-19T12:57:10.380Z",
      },
    });
  };
}

function tempFile(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-monitor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "cooldown.json");
}

test("wechat sidecar monitor stays quiet when doctor is ok", async () => {
  const result = await runWechatClawbotMonitor({
    config: baseConfig,
    fetchImpl: fetchWithPendingOutbox(0),
    nowMs: Date.parse("2026-05-19T12:57:11.000Z"),
    notifyTo: "channel:telegram:123",
    notifyImpl: async () => {
      throw new Error("should not notify");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.monitorStatus, "ok");
  assert.equal(result.notified, false);
  assert.match(result.runAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(formatWechatClawbotMonitorResult(result), /monitor-status: ok/);
});

test("wechat sidecar monitor sends notification when doctor has issues", async () => {
  process.env.HIBOSS_MONITOR_TOKEN = "agent-token";
  let notifiedText = "";
  const result = await runWechatClawbotMonitor({
    config: baseConfig,
    fetchImpl: fetchWithPendingOutbox(2),
    nowMs: Date.parse("2026-05-19T12:57:11.000Z"),
    notifyTo: "channel:telegram:123",
    notifyTokenEnv: "HIBOSS_MONITOR_TOKEN",
    notifyImpl: async ({ token, to, text }) => {
      assert.equal(token, "agent-token");
      assert.equal(to, "channel:telegram:123");
      notifiedText = text;
      return { id: "12345678-1234-4234-8234-123456789abc" };
    },
  });

  assert.equal(result.monitorStatus, "alert");
  assert.equal(result.notified, true);
  assert.equal(result.envelopeId, "12345678");
  assert.match(notifiedText, /pending-outbox: 2/);
  assert.match(formatWechatClawbotMonitorResult(result), /envelope-id: 12345678/);
  delete process.env.HIBOSS_MONITOR_TOKEN;
});

test("wechat sidecar monitor suppresses repeated alerts during cooldown", async (t) => {
  process.env.HIBOSS_MONITOR_TOKEN = "agent-token";
  const cooldownFile = tempFile(t);
  let notifyCount = 0;
  const notifyImpl = async () => {
    notifyCount += 1;
    return { id: "12345678-1234-4234-8234-123456789abc" };
  };

  const first = await runWechatClawbotMonitor({
    config: baseConfig,
    fetchImpl: fetchWithPendingOutbox(2),
    notifyTo: "channel:telegram:123",
    notifyTokenEnv: "HIBOSS_MONITOR_TOKEN",
    cooldownFile,
    cooldownMs: 10_000,
    nowMs: 1_700_000_000_000,
    notifyImpl,
  });
  const second = await runWechatClawbotMonitor({
    config: baseConfig,
    fetchImpl: fetchWithPendingOutbox(2),
    notifyTo: "channel:telegram:123",
    notifyTokenEnv: "HIBOSS_MONITOR_TOKEN",
    cooldownFile,
    cooldownMs: 10_000,
    nowMs: 1_700_000_001_000,
    notifyImpl,
  });

  assert.equal(first.monitorStatus, "alert");
  assert.equal(second.monitorStatus, "suppressed");
  assert.equal(second.cooldownActive, true);
  assert.equal(notifyCount, 1);
  delete process.env.HIBOSS_MONITOR_TOKEN;
});

test("wechat sidecar monitor parses notification flags", () => {
  assert.deepEqual(parseWechatClawbotMonitorCliArgs([
    "--hiboss-dir",
    "/var/lib/hiboss",
    "--agent",
    "nex",
    "--notify-to",
    "channel:telegram:123",
    "--cooldown-ms",
    "60000",
    "--dry-run",
  ]), {
    hibossDir: "/var/lib/hiboss",
    agentName: "nex",
    notifyTo: "channel:telegram:123",
    cooldownMs: 60000,
    dryRun: true,
  });
});

test("wechat sidecar monitor status reports installed cron health", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-monitor-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cronFile = path.join(dir, "monitor.cron");
  const logFile = path.join(dir, "monitor.log");
  fs.writeFileSync(
    cronFile,
    "*/5 * * * * root hiboss-wechat-clawbot-sidecar monitor --notify-to \"channel:telegram:123\" >> /tmp/log 2>&1\n"
  );
  fs.writeFileSync(
    logFile,
    [
      "ok: true",
      "run-at: 2026-05-19T14:00:00.000Z",
      "monitor-status: ok",
      "doctor-status: ok",
      "notified: false",
      "issue-count: 0",
      "",
    ].join("\n")
  );

  const result = runWechatClawbotMonitorStatus({
    cronFile,
    logFile,
    nowMs: Date.parse("2026-05-19T14:05:00.000Z"),
    cronActiveImpl: () => true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.maxAgeMinutes, 15);
  assert.equal(result.cronCommandPresent, true);
  assert.equal(result.cronNotifyTargetConfigured, true);
  assert.equal(result.lastRunFresh, true);
  assert.equal(result.lastRunAgeSeconds, 300);
  assert.equal(result.lastMonitorStatus, "ok");
  assert.equal(result.lastIssueCount, "0");
  const output = formatWechatClawbotMonitorStatusResult(result);
  assert.match(output, /cron-active: true/);
  assert.match(output, /last-run-fresh: true/);
  assert.match(output, /last-monitor-status: ok/);
});

test("wechat sidecar monitor status uses latest log block and rejects stale runs", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-monitor-status-stale-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cronFile = path.join(dir, "monitor.cron");
  const logFile = path.join(dir, "monitor.log");
  fs.writeFileSync(
    cronFile,
    "*/5 * * * * root hiboss-wechat-clawbot-sidecar monitor --notify-to channel:telegram:123 >> /tmp/log 2>&1\n"
  );
  fs.writeFileSync(
    logFile,
    [
      "ok: false",
      "run-at: 2026-05-19T13:00:00.000Z",
      "monitor-status: alert",
      "doctor-status: warn",
      "notified: true",
      "issue-count: 1",
      "ok: true",
      "run-at: 2026-05-19T14:00:00.000Z",
      "monitor-status: ok",
      "doctor-status: ok",
      "notified: false",
      "issue-count: 0",
      "",
    ].join("\n")
  );

  const result = runWechatClawbotMonitorStatus({
    cronFile,
    logFile,
    maxAgeMinutes: 15,
    nowMs: Date.parse("2026-05-19T14:20:01.000Z"),
    cronActiveImpl: () => true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.lastRunFresh, false);
  assert.equal(result.lastRunAgeSeconds, 1201);
  assert.equal(result.lastMonitorStatus, "ok");
  assert.equal(result.lastIssueCount, "0");
});

test("wechat sidecar monitor status parses file flags", () => {
  assert.deepEqual(parseWechatClawbotMonitorStatusCliArgs([
    "--hiboss-dir",
    "/var/lib/hiboss",
    "--cron-file",
    "/etc/cron.d/test",
    "--log-file",
    "/var/log/test.log",
    "--max-age-minutes",
    "30",
  ]), {
    hibossDir: "/var/lib/hiboss",
    cronFile: "/etc/cron.d/test",
    logFile: "/var/log/test.log",
    maxAgeMinutes: 30,
  });
});
