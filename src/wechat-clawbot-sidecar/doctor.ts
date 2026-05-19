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
  contextActive?: number;
  contextExpiringSoon?: number;
  contextExpired?: number;
  nextContextExpiresAt?: string;
  ilinkPollEnabled?: boolean;
  ilinkPollLastStartedAt?: string;
  ilinkPollLastCompletedAt?: string;
  ilinkPollLastErrorAt?: string;
  ilinkPollLastError?: string;
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
  fetchImpl?: FetchLike;
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

export async function runWechatClawbotDoctor(options: WechatClawbotDoctorOptions): Promise<WechatClawbotDoctorResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sidecarUrl = getWechatClawbotSidecarBaseUrl(options.config);
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
  summary.contextActive = numberField(state, "context_active");
  summary.contextExpiringSoon = numberField(state, "context_expiring_soon");
  summary.contextExpired = numberField(state, "context_expired");
  summary.nextContextExpiresAt = stringField(state, "next_context_expires_at");

  const ilinkPoll = objectRecord(statusBody?.ilink_poll);
  summary.ilinkPollEnabled = boolField(ilinkPoll, "enabled");
  summary.ilinkPollLastStartedAt = stringField(ilinkPoll, "last_started_at");
  summary.ilinkPollLastCompletedAt = stringField(ilinkPoll, "last_completed_at");
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
    `context-active: ${valueOrNone(result.summary.contextActive)}`,
    `context-expiring-soon: ${valueOrNone(result.summary.contextExpiringSoon)}`,
    `context-expired: ${valueOrNone(result.summary.contextExpired)}`,
    `next-context-expires-at: ${valueOrNone(result.summary.nextContextExpiresAt)}`,
    `ilink-poll-enabled: ${valueOrNone(result.summary.ilinkPollEnabled)}`,
    `ilink-poll-last-started-at: ${valueOrNone(result.summary.ilinkPollLastStartedAt)}`,
    `ilink-poll-last-completed-at: ${valueOrNone(result.summary.ilinkPollLastCompletedAt)}`,
    `ilink-poll-last-error-at: ${valueOrNone(result.summary.ilinkPollLastErrorAt)}`,
    `ilink-poll-last-error: ${valueOrNone(result.summary.ilinkPollLastError)}`,
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
