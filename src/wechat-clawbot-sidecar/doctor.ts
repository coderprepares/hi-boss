import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

import type { WechatClawbotSidecarConfig } from "./types.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface WechatClawbotDoctorIssue {
  level: "error" | "warning";
  name: string;
  message: string;
}

export interface WechatClawbotDoctorSummary {
  healthOk?: boolean;
  healthTransport?: string;
  statusOk?: boolean;
  transport?: string;
  accounts?: number;
  peers?: number;
  events?: number;
  nextCursor?: string;
  pendingOutbox?: number;
  sentMessages?: number;
  lastSentAt?: string;
  contextActive?: number;
  contextExpiringSoon?: number;
  contextExpired?: number;
  nextContextExpiresAt?: string;
  ilinkPollEnabled?: boolean;
  ilinkPollLastStartedAt?: string;
  ilinkPollLastStartedAgeSeconds?: number;
  ilinkPollLastCompletedAt?: string;
  ilinkPollLastCompletedAgeSeconds?: number;
  ilinkPollMaxAgeSeconds?: number;
  ilinkPollLastErrorAt?: string;
  ilinkPollLastError?: string;
  hibossDir?: string;
  hibossDbExists?: boolean;
  hibossDaemonPidFileExists?: boolean;
  hibossDaemonProcessAlive?: boolean;
  hibossDaemonSocketExists?: boolean;
  hibossAgent?: string;
  hibossAgentExists?: boolean;
  hibossWechatBinding?: boolean;
  hibossBossIdConfigured?: boolean;
  hibossWechatCursorCount?: number;
  hibossWechatCursorMax?: string;
  hibossCursorMatchesSidecar?: boolean;
  hibossRecentWechatPollFailures?: number;
}

export interface WechatClawbotDoctorResult {
  ok: boolean;
  status: "ok" | "warn" | "error";
  sidecarUrl: string;
  summary: WechatClawbotDoctorSummary;
  issues: WechatClawbotDoctorIssue[];
}

export interface WechatClawbotDoctorOptions {
  config: WechatClawbotSidecarConfig;
  hibossDir?: string;
  agentName?: string;
  nowMs?: number;
  fetchImpl?: FetchLike;
}

export interface WechatClawbotDoctorCliOptions {
  hibossDir?: string;
  agentName?: string;
}

function probeHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function getWechatClawbotSidecarBaseUrl(config: Pick<WechatClawbotSidecarConfig, "host" | "port">): string {
  return `http://${probeHost(config.host)}:${config.port}`;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolField(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  requestTimeoutMs: number
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
    return { status: response.status, body: await response.json() };
  } finally {
    clearTimeout(timeout);
  }
}

function addIssue(
  issues: WechatClawbotDoctorIssue[],
  level: WechatClawbotDoctorIssue["level"],
  name: string,
  message: string
): void {
  issues.push({ level, name, message });
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function processAlive(pid: number | undefined): boolean | undefined {
  if (pid === undefined) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function maxNumericString(values: string[]): string | undefined {
  const numeric = values
    .filter((value) => /^\d+$/.test(value))
    .map((value) => BigInt(value));
  if (numeric.length === 0) return undefined;
  return numeric.reduce((max, value) => value > max ? value : max, numeric[0]).toString();
}

function ageSecondsSince(isoTimestamp: string | undefined, nowMs: number): number | undefined {
  if (!isoTimestamp) return undefined;
  const timestampMs = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestampMs)) return undefined;
  return Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
}

function countRecentWechatPollFailures(logPath: string): number | undefined {
  if (!fs.existsSync(logPath)) return undefined;
  try {
    const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).slice(-200);
    return lines.filter((line) => line.includes("[wechat-clawbot] sidecar poll failed")).length;
  } catch {
    return undefined;
  }
}

function inspectHibossLocalState(params: {
  hibossDir: string;
  agentName?: string;
  sidecarNextCursor?: string;
  summary: WechatClawbotDoctorSummary;
  issues: WechatClawbotDoctorIssue[];
}): void {
  const daemonDir = path.join(params.hibossDir, ".daemon");
  const dbPath = path.join(daemonDir, "hiboss.db");
  const pidPath = path.join(daemonDir, "daemon.pid");
  const socketPath = path.join(daemonDir, "daemon.sock");
  const logPath = path.join(daemonDir, "daemon.log");

  params.summary.hibossDir = params.hibossDir;
  params.summary.hibossDbExists = fs.existsSync(dbPath);
  params.summary.hibossDaemonPidFileExists = fs.existsSync(pidPath);
  params.summary.hibossDaemonSocketExists = fs.existsSync(socketPath);
  params.summary.hibossRecentWechatPollFailures = countRecentWechatPollFailures(logPath);

  if (params.summary.hibossDaemonPidFileExists) {
    try {
      const pid = parsePositiveInt(fs.readFileSync(pidPath, "utf8").trim());
      params.summary.hibossDaemonProcessAlive = processAlive(pid);
    } catch {
      params.summary.hibossDaemonProcessAlive = undefined;
    }
  }
  if (!params.summary.hibossDaemonPidFileExists) {
    addIssue(params.issues, "warning", "hiboss-daemon-pid", "Hi-Boss daemon PID file is missing");
  } else if (params.summary.hibossDaemonProcessAlive === undefined) {
    addIssue(params.issues, "warning", "hiboss-daemon-pid", "Hi-Boss daemon PID file is not readable or invalid");
  } else if (params.summary.hibossDaemonProcessAlive === false) {
    addIssue(params.issues, "warning", "hiboss-daemon-process", "Hi-Boss daemon PID is not alive");
  }
  if (!params.summary.hibossDaemonSocketExists) {
    addIssue(params.issues, "warning", "hiboss-daemon-socket", "Hi-Boss daemon socket is missing");
  }
  if (!params.summary.hibossDbExists) {
    addIssue(params.issues, "error", "hiboss-db", "Hi-Boss SQLite database is missing");
    return;
  }

  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      if (params.agentName) {
        params.summary.hibossAgent = params.agentName;
        const agent = db.prepare("SELECT name FROM agents WHERE lower(name) = lower(?)").get(params.agentName) as
          | { name: string }
          | undefined;
        params.summary.hibossAgentExists = Boolean(agent);
        if (!agent) {
          addIssue(params.issues, "warning", "hiboss-agent", `Hi-Boss agent '${params.agentName}' was not found`);
        } else {
          const binding = db.prepare(
            "SELECT COUNT(*) AS count FROM agent_bindings WHERE agent_name = ? AND adapter_type = 'wechat-clawbot'"
          ).get(agent.name) as { count: number };
          params.summary.hibossWechatBinding = binding.count > 0;
          if (binding.count === 0) {
            addIssue(
              params.issues,
              "warning",
              "hiboss-wechat-binding",
              `Agent '${agent.name}' has no wechat-clawbot binding`
            );
          }
        }
      }

      const bossId = db.prepare("SELECT value FROM config WHERE key = 'adapter_boss_id_wechat-clawbot'").get() as
        | { value: string }
        | undefined;
      params.summary.hibossBossIdConfigured = Boolean(bossId?.value?.trim());
      if (!params.summary.hibossBossIdConfigured) {
        addIssue(params.issues, "warning", "hiboss-boss-id", "adapter_boss_id_wechat-clawbot is not configured");
      }

      const cursorRows = db.prepare(
        "SELECT value FROM config WHERE key LIKE 'adapter_cursor_v1:wechat-clawbot:%'"
      ).all() as Array<{ value: string }>;
      const cursorValues = cursorRows.map((row) => String(row.value));
      params.summary.hibossWechatCursorCount = cursorValues.length;
      params.summary.hibossWechatCursorMax = maxNumericString(cursorValues);
      if (cursorValues.length === 0) {
        addIssue(params.issues, "warning", "hiboss-wechat-cursor", "No persisted wechat-clawbot adapter cursor was found");
      }
      if (params.sidecarNextCursor && cursorValues.length > 0) {
        params.summary.hibossCursorMatchesSidecar = cursorValues.includes(params.sidecarNextCursor);
        if (!params.summary.hibossCursorMatchesSidecar) {
          addIssue(
            params.issues,
            "warning",
            "hiboss-wechat-cursor-lag",
            "Persisted adapter cursor does not match sidecar next-cursor"
          );
        }
      }
    } finally {
      db.close();
    }
  } catch (err) {
    addIssue(
      params.issues,
      "error",
      "hiboss-db-read",
      err instanceof Error ? err.message : String(err)
    );
  }
}

export async function runWechatClawbotDoctor(options: WechatClawbotDoctorOptions): Promise<WechatClawbotDoctorResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sidecarUrl = getWechatClawbotSidecarBaseUrl(options.config);
  const nowMs = options.nowMs ?? Date.now();
  const issues: WechatClawbotDoctorIssue[] = [];
  const summary: WechatClawbotDoctorSummary = {};

  let health: Record<string, unknown> | undefined;
  try {
    const result = await fetchJson(fetchImpl, `${sidecarUrl}/healthz`, options.config.requestTimeoutMs);
    health = objectRecord(result.body);
    summary.healthOk = boolField(health, "ok");
    summary.healthTransport = stringField(health, "transport");
    if (result.status !== 200 || summary.healthOk !== true) {
      addIssue(issues, "error", "healthz", `sidecar health check returned HTTP ${result.status}`);
    }
  } catch (err) {
    addIssue(issues, "error", "healthz", err instanceof Error ? err.message : String(err));
  }

  let statusBody: Record<string, unknown> | undefined;
  try {
    const result = await fetchJson(fetchImpl, `${sidecarUrl}/status`, options.config.requestTimeoutMs);
    statusBody = objectRecord(result.body);
    summary.statusOk = boolField(statusBody, "ok");
    summary.transport = stringField(statusBody, "transport");
    if (result.status !== 200 || summary.statusOk !== true) {
      addIssue(issues, "error", "status-endpoint", `sidecar status returned HTTP ${result.status}`);
    }
  } catch (err) {
    addIssue(issues, "error", "status-endpoint", err instanceof Error ? err.message : String(err));
  }

  const statusJson = statusBody ? JSON.stringify(statusBody) : "";
  if (/\b(context_token|bot_token|apiToken|botToken|tokenFile|stateFile|text)\b/.test(statusJson)) {
    addIssue(issues, "error", "status-secret-surface", "status response appears to include sensitive fields");
  }

  const state = objectRecord(statusBody?.state);
  summary.accounts = numberField(state, "accounts");
  summary.peers = numberField(state, "peers");
  summary.events = numberField(state, "events");
  summary.nextCursor = stringField(state, "next_cursor");
  summary.pendingOutbox = numberField(state, "pending_outbox");
  summary.sentMessages = numberField(state, "sent_messages");
  summary.lastSentAt = stringField(objectRecord(state?.last_sent), "created_at");
  summary.contextActive = numberField(state, "context_active");
  summary.contextExpiringSoon = numberField(state, "context_expiring_soon");
  summary.contextExpired = numberField(state, "context_expired");
  summary.nextContextExpiresAt = stringField(state, "next_context_expires_at");

  const ilinkPoll = objectRecord(statusBody?.ilink_poll);
  summary.ilinkPollEnabled = boolField(ilinkPoll, "enabled");
  summary.ilinkPollLastStartedAt = stringField(ilinkPoll, "last_started_at");
  summary.ilinkPollLastStartedAgeSeconds = ageSecondsSince(summary.ilinkPollLastStartedAt, nowMs);
  summary.ilinkPollLastCompletedAt = stringField(ilinkPoll, "last_completed_at");
  summary.ilinkPollLastCompletedAgeSeconds = ageSecondsSince(summary.ilinkPollLastCompletedAt, nowMs);
  summary.ilinkPollMaxAgeSeconds = Math.ceil(Math.max(options.config.pollIntervalMs * 10, 60_000) / 1000);
  summary.ilinkPollLastErrorAt = stringField(ilinkPoll, "last_error_at");
  summary.ilinkPollLastError = stringField(ilinkPoll, "last_error");

  if (summary.healthTransport && summary.transport && summary.healthTransport !== summary.transport) {
    addIssue(issues, "warning", "transport-mismatch", "healthz and status report different transports");
  }
  if (summary.transport && summary.transport !== options.config.transport) {
    addIssue(issues, "warning", "config-transport-mismatch", "status transport differs from local config");
  }
  if ((summary.pendingOutbox ?? 0) > 0) {
    addIssue(issues, "warning", "pending-outbox", "sidecar has queued outbound messages");
  }
  if (summary.contextActive === 0) {
    addIssue(issues, "warning", "context-active", "no active reply context is currently available");
  }
  if ((summary.contextExpired ?? 0) > 0) {
    addIssue(issues, "warning", "context-expired", "one or more reply contexts are expired");
  }
  if ((summary.contextExpiringSoon ?? 0) > 0) {
    addIssue(issues, "warning", "context-expiring-soon", "one or more reply contexts expire within one hour");
  }
  if (summary.ilinkPollEnabled && summary.ilinkPollLastError) {
    addIssue(issues, "warning", "ilink-poll-error", summary.ilinkPollLastError);
  }
  if (summary.ilinkPollEnabled && !summary.ilinkPollLastStartedAt) {
    addIssue(issues, "warning", "ilink-poll-not-started", "iLink polling is enabled but has not started yet");
  }
  if (
    summary.ilinkPollEnabled &&
    summary.ilinkPollLastCompletedAgeSeconds === undefined &&
    summary.ilinkPollLastStartedAgeSeconds !== undefined &&
    summary.ilinkPollLastStartedAgeSeconds > summary.ilinkPollMaxAgeSeconds
  ) {
    addIssue(
      issues,
      "warning",
      "ilink-poll-incomplete",
      `iLink polling started ${summary.ilinkPollLastStartedAgeSeconds}s ago and has not completed`
    );
  }
  if (
    summary.ilinkPollEnabled &&
    summary.ilinkPollLastCompletedAgeSeconds !== undefined &&
    summary.ilinkPollLastCompletedAgeSeconds > summary.ilinkPollMaxAgeSeconds
  ) {
    addIssue(
      issues,
      "warning",
      "ilink-poll-stale",
      `iLink polling has not completed for ${summary.ilinkPollLastCompletedAgeSeconds}s`
    );
  }
  if (options.hibossDir) {
    inspectHibossLocalState({
      hibossDir: options.hibossDir,
      agentName: options.agentName,
      sidecarNextCursor: summary.nextCursor,
      summary,
      issues,
    });
  }

  const hasError = issues.some((issue) => issue.level === "error");
  const hasWarning = issues.some((issue) => issue.level === "warning");
  return {
    ok: issues.length === 0,
    status: hasError ? "error" : hasWarning ? "warn" : "ok",
    sidecarUrl,
    summary,
    issues,
  };
}

function valueOrNone(value: unknown): string {
  return value === undefined || value === null || value === "" ? "(none)" : String(value);
}

export function formatWechatClawbotDoctorResult(result: WechatClawbotDoctorResult): string {
  const lines = [
    `ok: ${result.ok ? "true" : "false"}`,
    `status: ${result.status}`,
    `sidecar-url: ${result.sidecarUrl}`,
    `health-ok: ${valueOrNone(result.summary.healthOk)}`,
    `health-transport: ${valueOrNone(result.summary.healthTransport)}`,
    `status-ok: ${valueOrNone(result.summary.statusOk)}`,
    `transport: ${valueOrNone(result.summary.transport)}`,
    `accounts: ${valueOrNone(result.summary.accounts)}`,
    `peers: ${valueOrNone(result.summary.peers)}`,
    `events: ${valueOrNone(result.summary.events)}`,
    `next-cursor: ${valueOrNone(result.summary.nextCursor)}`,
    `pending-outbox: ${valueOrNone(result.summary.pendingOutbox)}`,
    `sent-messages: ${valueOrNone(result.summary.sentMessages)}`,
    `last-sent-at: ${valueOrNone(result.summary.lastSentAt)}`,
    `context-active: ${valueOrNone(result.summary.contextActive)}`,
    `context-expiring-soon: ${valueOrNone(result.summary.contextExpiringSoon)}`,
    `context-expired: ${valueOrNone(result.summary.contextExpired)}`,
    `next-context-expires-at: ${valueOrNone(result.summary.nextContextExpiresAt)}`,
    `ilink-poll-enabled: ${valueOrNone(result.summary.ilinkPollEnabled)}`,
    `ilink-poll-last-started-at: ${valueOrNone(result.summary.ilinkPollLastStartedAt)}`,
    `ilink-poll-last-started-age-seconds: ${valueOrNone(result.summary.ilinkPollLastStartedAgeSeconds)}`,
    `ilink-poll-last-completed-at: ${valueOrNone(result.summary.ilinkPollLastCompletedAt)}`,
    `ilink-poll-last-completed-age-seconds: ${valueOrNone(result.summary.ilinkPollLastCompletedAgeSeconds)}`,
    `ilink-poll-max-age-seconds: ${valueOrNone(result.summary.ilinkPollMaxAgeSeconds)}`,
    `ilink-poll-last-error-at: ${valueOrNone(result.summary.ilinkPollLastErrorAt)}`,
    `ilink-poll-last-error: ${valueOrNone(result.summary.ilinkPollLastError)}`,
    `hiboss-dir: ${valueOrNone(result.summary.hibossDir)}`,
    `hiboss-db-exists: ${valueOrNone(result.summary.hibossDbExists)}`,
    `hiboss-daemon-pid-file-exists: ${valueOrNone(result.summary.hibossDaemonPidFileExists)}`,
    `hiboss-daemon-process-alive: ${valueOrNone(result.summary.hibossDaemonProcessAlive)}`,
    `hiboss-daemon-socket-exists: ${valueOrNone(result.summary.hibossDaemonSocketExists)}`,
    `hiboss-agent: ${valueOrNone(result.summary.hibossAgent)}`,
    `hiboss-agent-exists: ${valueOrNone(result.summary.hibossAgentExists)}`,
    `hiboss-wechat-binding: ${valueOrNone(result.summary.hibossWechatBinding)}`,
    `hiboss-boss-id-configured: ${valueOrNone(result.summary.hibossBossIdConfigured)}`,
    `hiboss-wechat-cursor-count: ${valueOrNone(result.summary.hibossWechatCursorCount)}`,
    `hiboss-wechat-cursor-max: ${valueOrNone(result.summary.hibossWechatCursorMax)}`,
    `hiboss-cursor-matches-sidecar: ${valueOrNone(result.summary.hibossCursorMatchesSidecar)}`,
    `hiboss-recent-wechat-poll-failures: ${valueOrNone(result.summary.hibossRecentWechatPollFailures)}`,
    `issue-count: ${result.issues.length}`,
  ];

  result.issues.forEach((issue, index) => {
    const prefix = `issue-${index + 1}`;
    lines.push(`${prefix}-level: ${issue.level}`);
    lines.push(`${prefix}-name: ${issue.name}`);
    lines.push(`${prefix}-message: ${issue.message}`);
  });

  return lines.join("\n");
}

export function parseWechatClawbotDoctorCliArgs(args: string[]): WechatClawbotDoctorCliOptions {
  const result: WechatClawbotDoctorCliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--hiboss-dir") {
      const value = args[++index];
      if (!value) throw new Error("--hiboss-dir requires a value");
      result.hibossDir = value;
    } else if (arg === "--agent") {
      const value = args[++index];
      if (!value) throw new Error("--agent requires a value");
      result.agentName = value;
    } else {
      throw new Error(`Unknown arguments: ${args.slice(index).join(" ")}`);
    }
  }
  return result;
}
