import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  formatWechatClawbotDoctorResult,
  parseWechatClawbotDoctorCliArgs,
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

function createHibossDir(t: { after: (fn: () => void) => void }, options: {
  agentName?: string;
  bindWechat?: boolean;
  bossId?: string;
  cursor?: string;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-doctor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const daemonDir = path.join(root, ".daemon");
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(path.join(daemonDir, "daemon.pid"), `${process.pid}\n`);
  fs.writeFileSync(path.join(daemonDir, "daemon.sock"), "");
  fs.writeFileSync(path.join(daemonDir, "daemon.log"), "info: ok\n");

  const db = new Database(path.join(daemonDir, "hiboss.db"));
  try {
    db.exec(`
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE agents (name TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL);
      CREATE TABLE agent_bindings (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        adapter_type TEXT NOT NULL,
        adapter_token TEXT NOT NULL
      );
    `);
    if (options.agentName) {
      db.prepare("INSERT INTO agents (name, token) VALUES (?, ?)").run(options.agentName, "agent-token");
      if (options.bindWechat) {
        db.prepare(
          "INSERT INTO agent_bindings (id, agent_name, adapter_type, adapter_token) VALUES (?, ?, ?, ?)"
        ).run("binding-id", options.agentName, "wechat-clawbot", "wechat-token");
      }
    }
    if (options.bossId) {
      db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run("adapter_boss_id_wechat-clawbot", options.bossId);
    }
    if (options.cursor) {
      db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
        "adapter_cursor_v1:wechat-clawbot:test",
        options.cursor
      );
    }
  } finally {
    db.close();
  }
  return root;
}

function healthyFetch(nextCursor = "9"): FetchLike {
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
        next_cursor: nextCursor,
        pending_outbox: 0,
        sent_messages: 3,
        last_sent: { created_at: "2026-05-19T13:28:45.000Z" },
        context_active: 1,
        context_expiring_soon: 0,
        context_expired: 0,
        next_context_expires_at: "2026-05-20T08:05:43.455Z",
      },
      ilink_poll: {
        enabled: true,
        in_flight: false,
        last_started_at: "2026-05-19T12:57:09.380Z",
        last_completed_at: "2026-05-19T12:57:07.379Z",
        last_duration_ms: 123,
        consecutive_failures: 0,
      },
    });
  };
}

type FetchLike = NonNullable<Parameters<typeof runWechatClawbotDoctor>[0]["fetchImpl"]>;

test("wechat sidecar doctor reports ok for healthy status", async () => {
  const seen: string[] = [];
  const result = await runWechatClawbotDoctor({
    config: baseConfig,
    nowMs: Date.parse("2026-05-19T12:57:10.000Z"),
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
          sent_messages: 3,
          last_sent: { created_at: "2026-05-19T13:28:45.000Z" },
          context_active: 1,
          context_expiring_soon: 0,
          context_expired: 0,
          next_context_expires_at: "2026-05-20T08:05:43.455Z",
        },
        ilink_poll: {
          enabled: true,
          in_flight: false,
          last_started_at: "2026-05-19T12:57:09.380Z",
          last_completed_at: "2026-05-19T12:57:07.379Z",
          last_duration_ms: 123,
          consecutive_failures: 0,
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
  const output = formatWechatClawbotDoctorResult(result);
  assert.match(output, /pending-outbox: 0/);
  assert.match(output, /sent-messages: 3/);
  assert.match(output, /last-sent-at: 2026-05-19T13:28:45.000Z/);
  assert.match(output, /ilink-poll-last-duration-ms: 123/);
  assert.match(output, /ilink-poll-consecutive-failures: 0/);
  assert.match(output, /ilink-poll-last-completed-age-seconds: 2/);
});

test("wechat sidecar doctor can include healthy local hiboss state", async (t) => {
  const hibossDir = createHibossDir(t, {
    agentName: "nex",
    bindWechat: true,
    bossId: "wxid_boss",
    cursor: "9",
  });
  const result = await runWechatClawbotDoctor({
    config: baseConfig,
    hibossDir,
    agentName: "nex",
    nowMs: Date.parse("2026-05-19T12:57:10.000Z"),
    fetchImpl: healthyFetch("9"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.summary.hibossDbExists, true);
  assert.equal(result.summary.hibossDaemonProcessAlive, true);
  assert.equal(result.summary.hibossDaemonSocketExists, true);
  assert.equal(result.summary.hibossAgentExists, true);
  assert.equal(result.summary.hibossWechatBinding, true);
  assert.equal(result.summary.hibossBossIdConfigured, true);
  assert.equal(result.summary.hibossWechatCursorCount, 1);
  assert.equal(result.summary.hibossCursorMatchesSidecar, true);
  assert.match(formatWechatClawbotDoctorResult(result), /hiboss-wechat-binding: true/);
});

test("wechat sidecar doctor warns for missing local hiboss binding and cursor lag", async (t) => {
  const hibossDir = createHibossDir(t, {
    agentName: "nex",
    bindWechat: false,
    bossId: "wxid_boss",
    cursor: "8",
  });
  const result = await runWechatClawbotDoctor({
    config: baseConfig,
    hibossDir,
    agentName: "nex",
    nowMs: Date.parse("2026-05-19T12:57:10.000Z"),
    fetchImpl: healthyFetch("9"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "warn");
  assert.deepEqual(result.issues.map((issue) => issue.name), [
    "hiboss-wechat-binding",
    "hiboss-wechat-cursor-lag",
  ]);
  assert.equal(result.summary.hibossWechatBinding, false);
  assert.equal(result.summary.hibossCursorMatchesSidecar, false);
});

test("wechat sidecar doctor parses local hiboss flags", () => {
  assert.deepEqual(parseWechatClawbotDoctorCliArgs(["--hiboss-dir", "/var/lib/hiboss", "--agent", "nex"]), {
    hibossDir: "/var/lib/hiboss",
    agentName: "nex",
  });
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

test("wechat sidecar doctor warns when iLink polling completion is stale", async () => {
  const result = await runWechatClawbotDoctor({
    config: baseConfig,
    nowMs: Date.parse("2026-05-19T14:02:01.000Z"),
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
          pending_outbox: 0,
          context_active: 1,
          context_expiring_soon: 0,
          context_expired: 0,
        },
        ilink_poll: {
          enabled: true,
          last_started_at: "2026-05-19T14:00:00.000Z",
          last_completed_at: "2026-05-19T14:00:00.000Z",
        },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "warn");
  assert.equal(result.summary.ilinkPollLastCompletedAgeSeconds, 121);
  assert.equal(result.summary.ilinkPollMaxAgeSeconds, 60);
  assert.deepEqual(result.issues.map((issue) => issue.name), ["ilink-poll-stale"]);
  assert.match(formatWechatClawbotDoctorResult(result), /issue-1-name: ilink-poll-stale/);
});

test("wechat sidecar doctor warns when iLink polling never completes", async () => {
  const result = await runWechatClawbotDoctor({
    config: baseConfig,
    nowMs: Date.parse("2026-05-19T14:02:01.000Z"),
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
          pending_outbox: 0,
          context_active: 1,
          context_expiring_soon: 0,
          context_expired: 0,
        },
        ilink_poll: {
          enabled: true,
          last_started_at: "2026-05-19T14:00:00.000Z",
        },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "warn");
  assert.equal(result.summary.ilinkPollLastStartedAgeSeconds, 121);
  assert.deepEqual(result.issues.map((issue) => issue.name), ["ilink-poll-incomplete"]);
  assert.match(formatWechatClawbotDoctorResult(result), /issue-1-name: ilink-poll-incomplete/);
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
