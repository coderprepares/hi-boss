import Database from "better-sqlite3";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { IpcClient } from "../cli/ipc-client.js";
import { formatShortId } from "../shared/id-format.js";
import {
  runWechatClawbotDoctor,
  type WechatClawbotDoctorOptions,
  type WechatClawbotDoctorResult,
} from "./doctor.js";

export interface WechatClawbotMonitorCliOptions {
  hibossDir?: string;
  agentName?: string;
  notifyTo?: string;
  notifyAgent?: string;
  notifyTokenEnv?: string;
  notifyTokenFile?: string;
  cooldownFile?: string;
  cooldownMs?: number;
  dryRun?: boolean;
}

export interface WechatClawbotMonitorResult {
  ok: boolean;
  monitorStatus: "ok" | "alert" | "suppressed" | "notify-error";
  doctor: WechatClawbotDoctorResult;
  notified: boolean;
  dryRun: boolean;
  cooldownActive: boolean;
  cooldownFile?: string;
  cooldownUntil?: string;
  envelopeId?: string;
  notificationError?: string;
}

export interface WechatClawbotMonitorOptions extends WechatClawbotDoctorOptions, WechatClawbotMonitorCliOptions {
  nowMs?: number;
  notifyImpl?: (params: { token: string; to: string; text: string; hibossDir?: string }) => Promise<{ id?: string }>;
}

export interface WechatClawbotMonitorStatusCliOptions {
  hibossDir?: string;
  cronFile?: string;
  logFile?: string;
}

export interface WechatClawbotMonitorStatusResult {
  ok: boolean;
  cronFile: string;
  cronFileExists: boolean;
  cronCommandPresent?: boolean;
  cronNotifyTargetConfigured?: boolean;
  cronActive: boolean | "unknown";
  logFile: string;
  logFileExists: boolean;
  lastRunAt?: string;
  lastMonitorStatus?: string;
  lastDoctorStatus?: string;
  lastNotified?: string;
  lastIssueCount?: string;
}

export interface WechatClawbotMonitorStatusOptions extends WechatClawbotMonitorStatusCliOptions {
  cronActiveImpl?: () => boolean | "unknown";
}

interface CooldownState {
  fingerprint?: string;
  notifiedAt?: number;
}

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_CRON_FILE = "/etc/cron.d/hiboss-wechat-clawbot-monitor";
const DEFAULT_LOG_FILE = "/var/log/hiboss-wechat-clawbot-monitor.log";

function valueOrNone(value: unknown): string {
  return value === undefined || value === null || value === "" ? "(none)" : String(value);
}

function parseNonNegativeInt(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${label} requires a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is too large`);
  return parsed;
}

function defaultCooldownFile(hibossDir: string | undefined): string | undefined {
  if (!hibossDir) return undefined;
  return path.join(hibossDir, ".daemon", "wechat-clawbot-monitor.cooldown.json");
}

function probeCronActive(): boolean | "unknown" {
  let sawInactiveService = false;
  for (const service of ["crond", "cron"]) {
    let output = "";
    try {
      output = execFileSync("systemctl", ["is-active", service], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch (error) {
      const stdout = (error as { stdout?: Buffer | string }).stdout;
      output = Buffer.isBuffer(stdout) ? stdout.toString("utf8").trim() : typeof stdout === "string" ? stdout.trim() : "";
    }
    if (output === "active") return true;
    if (output && output !== "unknown") sawInactiveService = true;
  }
  return sawInactiveService ? false : "unknown";
}

function parseLastKeyValueBlock(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.trimEnd().split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.includes(": ")) {
      if (Object.keys(result).length > 0) break;
      continue;
    }
    const index = line.indexOf(": ");
    const key = line.slice(0, index);
    if (/^[a-z0-9-]+$/.test(key)) result[key] = line.slice(index + 2);
  }
  return result;
}

function readCooldown(file: string | undefined): CooldownState | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CooldownState;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeCooldown(file: string | undefined, state: CooldownState): void {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function alertFingerprint(doctor: WechatClawbotDoctorResult): string {
  return JSON.stringify({
    status: doctor.status,
    issues: doctor.issues.map((issue) => [issue.level, issue.name, issue.message]),
  });
}

function buildAlertText(doctor: WechatClawbotDoctorResult): string {
  const lines = [
    `Hi-Boss WeChat monitor: ${doctor.status}`,
    `pending-outbox: ${valueOrNone(doctor.summary.pendingOutbox)}`,
    `sent-messages: ${valueOrNone(doctor.summary.sentMessages)}`,
    `last-sent-at: ${valueOrNone(doctor.summary.lastSentAt)}`,
    `hiboss-cursor-matches-sidecar: ${valueOrNone(doctor.summary.hibossCursorMatchesSidecar)}`,
    `hiboss-recent-wechat-poll-failures: ${valueOrNone(doctor.summary.hibossRecentWechatPollFailures)}`,
    `issue-count: ${doctor.issues.length}`,
  ];
  doctor.issues.forEach((issue, index) => {
    lines.push(`issue-${index + 1}: ${issue.level} ${issue.name} - ${issue.message}`);
  });
  return lines.join("\n");
}

function readAgentTokenFromDb(hibossDir: string | undefined, agentName: string | undefined): string | undefined {
  if (!hibossDir || !agentName) return undefined;
  const dbPath = path.join(hibossDir, ".daemon", "hiboss.db");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT token FROM agents WHERE lower(name) = lower(?)").get(agentName) as
      | { token: string }
      | undefined;
    return row?.token?.trim() || undefined;
  } finally {
    db.close();
  }
}

function resolveNotifyToken(options: WechatClawbotMonitorOptions): string | undefined {
  if (options.notifyTokenEnv) {
    const token = process.env[options.notifyTokenEnv]?.trim();
    if (!token) throw new Error(`Notification token env is empty: ${options.notifyTokenEnv}`);
    return token;
  }
  if (options.notifyTokenFile) {
    const token = fs.readFileSync(options.notifyTokenFile, "utf8").trim();
    if (!token) throw new Error("Notification token file is empty");
    return token;
  }
  return readAgentTokenFromDb(options.hibossDir, options.notifyAgent ?? options.agentName);
}

async function sendEnvelopeViaIpc(params: { token: string; to: string; text: string; hibossDir?: string }): Promise<{ id?: string }> {
  const rootDir = params.hibossDir ?? process.env.HIBOSS_DIR ?? path.join(os.homedir(), "hiboss");
  const client = new IpcClient(path.join(rootDir, ".daemon", "daemon.sock"));
  return client.call<{ id?: string }>("envelope.send", {
    token: params.token,
    to: params.to,
    text: params.text,
    parseMode: "plain",
  });
}

export async function runWechatClawbotMonitor(options: WechatClawbotMonitorOptions): Promise<WechatClawbotMonitorResult> {
  const doctor = await runWechatClawbotDoctor(options);
  const alert = doctor.issues.length > 0;
  const nowMs = options.nowMs ?? Date.now();
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const cooldownFile = options.cooldownFile ?? defaultCooldownFile(options.hibossDir);
  const fingerprint = alert ? alertFingerprint(doctor) : undefined;
  const cooldown = readCooldown(cooldownFile);
  const lastNotifiedAt = typeof cooldown?.notifiedAt === "number" ? cooldown.notifiedAt : undefined;
  const cooldownActive = Boolean(
    alert &&
      cooldownMs > 0 &&
      cooldown?.fingerprint === fingerprint &&
      lastNotifiedAt !== undefined &&
      nowMs - lastNotifiedAt < cooldownMs
  );

  if (!alert) {
    return { ok: true, monitorStatus: "ok", doctor, notified: false, dryRun: Boolean(options.dryRun), cooldownActive: false, cooldownFile };
  }

  const cooldownUntil = cooldownActive && lastNotifiedAt !== undefined
    ? new Date(lastNotifiedAt + cooldownMs).toISOString()
    : undefined;
  if (cooldownActive) {
    return {
      ok: false,
      monitorStatus: "suppressed",
      doctor,
      notified: false,
      dryRun: Boolean(options.dryRun),
      cooldownActive,
      cooldownFile,
      cooldownUntil,
    };
  }

  if (options.dryRun || !options.notifyTo) {
    return { ok: false, monitorStatus: "alert", doctor, notified: false, dryRun: Boolean(options.dryRun), cooldownActive, cooldownFile };
  }

  try {
    const token = resolveNotifyToken(options);
    if (!token) throw new Error("Notification token is not configured");
    const notify = options.notifyImpl ?? sendEnvelopeViaIpc;
    const sent = await notify({ token, to: options.notifyTo, text: buildAlertText(doctor), hibossDir: options.hibossDir });
    writeCooldown(cooldownFile, { fingerprint, notifiedAt: nowMs });
    return {
      ok: false,
      monitorStatus: "alert",
      doctor,
      notified: true,
      dryRun: false,
      cooldownActive,
      cooldownFile,
      envelopeId: sent.id ? formatShortId(sent.id) : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      monitorStatus: "notify-error",
      doctor,
      notified: false,
      dryRun: false,
      cooldownActive,
      cooldownFile,
      notificationError: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatWechatClawbotMonitorResult(result: WechatClawbotMonitorResult): string {
  const lines = [
    `ok: ${result.ok ? "true" : "false"}`,
    `monitor-status: ${result.monitorStatus}`,
    `doctor-status: ${result.doctor.status}`,
    `notified: ${result.notified ? "true" : "false"}`,
    `dry-run: ${result.dryRun ? "true" : "false"}`,
    `cooldown-active: ${result.cooldownActive ? "true" : "false"}`,
    `cooldown-file: ${valueOrNone(result.cooldownFile)}`,
    `cooldown-until: ${valueOrNone(result.cooldownUntil)}`,
    `envelope-id: ${valueOrNone(result.envelopeId)}`,
    `notification-error: ${valueOrNone(result.notificationError)}`,
    `pending-outbox: ${valueOrNone(result.doctor.summary.pendingOutbox)}`,
    `sent-messages: ${valueOrNone(result.doctor.summary.sentMessages)}`,
    `last-sent-at: ${valueOrNone(result.doctor.summary.lastSentAt)}`,
    `hiboss-cursor-matches-sidecar: ${valueOrNone(result.doctor.summary.hibossCursorMatchesSidecar)}`,
    `hiboss-recent-wechat-poll-failures: ${valueOrNone(result.doctor.summary.hibossRecentWechatPollFailures)}`,
    `issue-count: ${result.doctor.issues.length}`,
  ];
  result.doctor.issues.forEach((issue, index) => {
    const prefix = `issue-${index + 1}`;
    lines.push(`${prefix}-level: ${issue.level}`);
    lines.push(`${prefix}-name: ${issue.name}`);
    lines.push(`${prefix}-message: ${issue.message}`);
  });
  return lines.join("\n");
}

export function parseWechatClawbotMonitorCliArgs(args: string[]): WechatClawbotMonitorCliOptions {
  const result: WechatClawbotMonitorCliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--hiboss-dir") {
      result.hibossDir = args[++index];
      if (!result.hibossDir) throw new Error("--hiboss-dir requires a value");
    } else if (arg === "--agent") {
      result.agentName = args[++index];
      if (!result.agentName) throw new Error("--agent requires a value");
    } else if (arg === "--notify-to") {
      result.notifyTo = args[++index];
      if (!result.notifyTo) throw new Error("--notify-to requires a value");
    } else if (arg === "--notify-agent") {
      result.notifyAgent = args[++index];
      if (!result.notifyAgent) throw new Error("--notify-agent requires a value");
    } else if (arg === "--notify-token-env") {
      result.notifyTokenEnv = args[++index];
      if (!result.notifyTokenEnv) throw new Error("--notify-token-env requires a value");
    } else if (arg === "--notify-token-file") {
      result.notifyTokenFile = args[++index];
      if (!result.notifyTokenFile) throw new Error("--notify-token-file requires a value");
    } else if (arg === "--cooldown-file") {
      result.cooldownFile = args[++index];
      if (!result.cooldownFile) throw new Error("--cooldown-file requires a value");
    } else if (arg === "--cooldown-ms") {
      result.cooldownMs = parseNonNegativeInt(args[++index], "--cooldown-ms");
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else {
      throw new Error(`Unknown arguments: ${args.slice(index).join(" ")}`);
    }
  }
  return result;
}

export function runWechatClawbotMonitorStatus(options: WechatClawbotMonitorStatusOptions = {}): WechatClawbotMonitorStatusResult {
  const cronFile = options.cronFile ?? DEFAULT_CRON_FILE;
  const logFile = options.logFile ?? DEFAULT_LOG_FILE;
  const cronFileExists = fs.existsSync(cronFile);
  const logFileExists = fs.existsSync(logFile);
  const cronText = cronFileExists ? fs.readFileSync(cronFile, "utf8") : "";
  const cronCommandPresent = cronFileExists
    ? /hiboss-wechat-clawbot-sidecar['"]?\s+monitor\b/.test(cronText)
    : undefined;
  const cronNotifyTargetConfigured = cronFileExists ? /--notify-to\s+["']?channel:[^"' \t]+/.test(cronText) : undefined;
  const cronActive = options.cronActiveImpl ? options.cronActiveImpl() : probeCronActive();
  const logStats = logFileExists ? fs.statSync(logFile) : undefined;
  const last = logFileExists ? parseLastKeyValueBlock(fs.readFileSync(logFile, "utf8")) : {};
  const lastIssueCount = last["issue-count"];
  const lastOk = last["monitor-status"] === "ok" && lastIssueCount === "0";
  const ok = Boolean(
    cronFileExists &&
      cronCommandPresent &&
      cronNotifyTargetConfigured &&
      cronActive === true &&
      logFileExists &&
      lastOk
  );

  return {
    ok,
    cronFile,
    cronFileExists,
    cronCommandPresent,
    cronNotifyTargetConfigured,
    cronActive,
    logFile,
    logFileExists,
    lastRunAt: logStats ? logStats.mtime.toISOString() : undefined,
    lastMonitorStatus: last["monitor-status"],
    lastDoctorStatus: last["doctor-status"],
    lastNotified: last.notified,
    lastIssueCount,
  };
}

export function formatWechatClawbotMonitorStatusResult(result: WechatClawbotMonitorStatusResult): string {
  return [
    `ok: ${result.ok ? "true" : "false"}`,
    `cron-file: ${result.cronFile}`,
    `cron-file-exists: ${result.cronFileExists ? "true" : "false"}`,
    `cron-command-present: ${valueOrNone(result.cronCommandPresent)}`,
    `cron-notify-target-configured: ${valueOrNone(result.cronNotifyTargetConfigured)}`,
    `cron-active: ${valueOrNone(result.cronActive)}`,
    `log-file: ${result.logFile}`,
    `log-file-exists: ${result.logFileExists ? "true" : "false"}`,
    `last-run-at: ${valueOrNone(result.lastRunAt)}`,
    `last-monitor-status: ${valueOrNone(result.lastMonitorStatus)}`,
    `last-doctor-status: ${valueOrNone(result.lastDoctorStatus)}`,
    `last-notified: ${valueOrNone(result.lastNotified)}`,
    `last-issue-count: ${valueOrNone(result.lastIssueCount)}`,
  ].join("\n");
}

export function parseWechatClawbotMonitorStatusCliArgs(args: string[]): WechatClawbotMonitorStatusCliOptions {
  const result: WechatClawbotMonitorStatusCliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--hiboss-dir") {
      result.hibossDir = args[++index];
      if (!result.hibossDir) throw new Error("--hiboss-dir requires a value");
    } else if (arg === "--cron-file") {
      result.cronFile = args[++index];
      if (!result.cronFile) throw new Error("--cron-file requires a value");
    } else if (arg === "--log-file") {
      result.logFile = args[++index];
      if (!result.logFile) throw new Error("--log-file requires a value");
    } else {
      throw new Error(`Unknown arguments: ${args.slice(index).join(" ")}`);
    }
  }
  return result;
}
