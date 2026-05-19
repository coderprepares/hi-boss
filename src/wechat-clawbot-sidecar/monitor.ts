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
import { buildWechatClawbotMonitorAlertText } from "./monitor-format.js";

export { formatWechatClawbotMonitorResult, formatWechatClawbotMonitorStatusResult } from "./monitor-format.js";

export interface WechatClawbotMonitorCliOptions {
  hibossDir?: string;
  agentName?: string;
  notifyTo?: string;
  notifyAgent?: string;
  notifyTokenEnv?: string;
  notifyTokenFile?: string;
  cooldownFile?: string;
  cooldownMs?: number;
  alertGraceMs?: number;
  dryRun?: boolean;
}

export interface WechatClawbotMonitorResult {
  ok: boolean;
  runAt: string;
  monitorStatus: "ok" | "grace" | "alert" | "suppressed" | "notify-error";
  doctor: WechatClawbotDoctorResult;
  notified: boolean;
  dryRun: boolean;
  cooldownActive: boolean;
  graceActive: boolean;
  cooldownFile?: string;
  cooldownUntil?: string;
  graceUntil?: string;
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
  maxAgeMinutes?: number;
}

export interface WechatClawbotMonitorStatusResult {
  ok: boolean;
  maxAgeMinutes: number;
  cronFile: string;
  cronFileExists: boolean;
  cronCommandPresent?: boolean;
  cronNotifyTargetConfigured?: boolean;
  cronActive: boolean | "unknown";
  logFile: string;
  logFileExists: boolean;
  lastRunAt?: string;
  lastRunFresh?: boolean;
  lastRunAgeSeconds?: number;
  lastMonitorStatus?: string;
  lastDoctorStatus?: string;
  lastNotified?: string;
  lastIssueCount?: string;
}

export interface WechatClawbotMonitorStatusOptions extends WechatClawbotMonitorStatusCliOptions {
  nowMs?: number;
  cronActiveImpl?: () => boolean | "unknown";
}

interface CooldownState {
  fingerprint?: string;
  firstSeenAt?: number;
  notifiedAt?: number;
}

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_ALERT_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_CRON_FILE = "/etc/cron.d/hiboss-wechat-clawbot-monitor";
const DEFAULT_LOG_FILE = "/var/log/hiboss-wechat-clawbot-monitor.log";
const DEFAULT_MONITOR_STATUS_MAX_AGE_MINUTES = 15;

function parseNonNegativeInt(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${label} requires a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is too large`);
  return parsed;
}

function parsePositiveInt(value: string | undefined, label: string): number {
  const parsed = parseNonNegativeInt(value, label);
  if (parsed < 1) throw new Error(`${label} requires a positive integer`);
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
    if (/^[a-z0-9-]+$/.test(key) && result[key] === undefined) result[key] = line.slice(index + 2);
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
  const runAt = new Date(nowMs).toISOString();
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const alertGraceMs = options.alertGraceMs ?? DEFAULT_ALERT_GRACE_MS;
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
    if (cooldown?.firstSeenAt !== undefined) writeCooldown(cooldownFile, { fingerprint: cooldown.fingerprint, notifiedAt: cooldown.notifiedAt });
    return { ok: true, runAt, monitorStatus: "ok", doctor, notified: false, dryRun: Boolean(options.dryRun), cooldownActive: false, graceActive: false, cooldownFile };
  }

  const cooldownUntil = cooldownActive && lastNotifiedAt !== undefined
    ? new Date(lastNotifiedAt + cooldownMs).toISOString()
    : undefined;
  if (cooldownActive) {
    return {
      ok: false,
      runAt,
      monitorStatus: "suppressed",
      doctor,
      notified: false,
      dryRun: Boolean(options.dryRun),
      cooldownActive,
      graceActive: false,
      cooldownFile,
      cooldownUntil,
    };
  }

  if (options.dryRun || !options.notifyTo) {
    return { ok: false, runAt, monitorStatus: "alert", doctor, notified: false, dryRun: Boolean(options.dryRun), cooldownActive, graceActive: false, cooldownFile };
  }

  const sameFingerprint = cooldown?.fingerprint === fingerprint;
  const firstSeenAt = sameFingerprint && typeof cooldown?.firstSeenAt === "number"
    ? cooldown.firstSeenAt
    : nowMs;
  const graceActive = alertGraceMs > 0 && nowMs - firstSeenAt < alertGraceMs;
  if (graceActive) {
    const nextCooldown: CooldownState = { fingerprint, firstSeenAt };
    if (sameFingerprint && cooldown?.notifiedAt !== undefined) nextCooldown.notifiedAt = cooldown.notifiedAt;
    writeCooldown(cooldownFile, nextCooldown);
    return {
      ok: false,
      runAt,
      monitorStatus: "grace",
      doctor,
      notified: false,
      dryRun: false,
      cooldownActive: false,
      graceActive: true,
      cooldownFile,
      graceUntil: new Date(firstSeenAt + alertGraceMs).toISOString(),
    };
  }

  try {
    const token = resolveNotifyToken(options);
    if (!token) throw new Error("Notification token is not configured");
    const notify = options.notifyImpl ?? sendEnvelopeViaIpc;
    const sent = await notify({ token, to: options.notifyTo, text: buildWechatClawbotMonitorAlertText(doctor), hibossDir: options.hibossDir });
    writeCooldown(cooldownFile, { fingerprint, notifiedAt: nowMs });
    return {
      ok: false,
      runAt,
      monitorStatus: "alert",
      doctor,
      notified: true,
      dryRun: false,
      cooldownActive,
      graceActive: false,
      cooldownFile,
      envelopeId: sent.id ? formatShortId(sent.id) : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      runAt,
      monitorStatus: "notify-error",
      doctor,
      notified: false,
      dryRun: false,
      cooldownActive,
      graceActive: false,
      cooldownFile,
      notificationError: err instanceof Error ? err.message : String(err),
    };
  }
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
    } else if (arg === "--alert-grace-ms") {
      result.alertGraceMs = parseNonNegativeInt(args[++index], "--alert-grace-ms");
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
  const maxAgeMinutes = options.maxAgeMinutes ?? DEFAULT_MONITOR_STATUS_MAX_AGE_MINUTES;
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
  const parsedRunAtMs = last["run-at"] ? Date.parse(last["run-at"]) : Number.NaN;
  const lastRunAt = Number.isFinite(parsedRunAtMs)
    ? new Date(parsedRunAtMs).toISOString()
    : logStats ? logStats.mtime.toISOString() : undefined;
  const lastRunMs = lastRunAt ? Date.parse(lastRunAt) : Number.NaN;
  const nowMs = options.nowMs ?? Date.now();
  const lastRunAgeSeconds = Number.isFinite(lastRunMs)
    ? Math.max(0, Math.floor((nowMs - lastRunMs) / 1000))
    : undefined;
  const lastRunFresh = lastRunAgeSeconds === undefined
    ? undefined
    : lastRunAgeSeconds <= maxAgeMinutes * 60;
  const lastIssueCount = last["issue-count"];
  const lastOk = last["monitor-status"] === "ok" && lastIssueCount === "0";
  const ok = Boolean(
    cronFileExists &&
      cronCommandPresent &&
      cronNotifyTargetConfigured &&
      cronActive === true &&
      logFileExists &&
      lastRunFresh === true &&
      lastOk
  );

  return {
    ok,
    maxAgeMinutes,
    cronFile,
    cronFileExists,
    cronCommandPresent,
    cronNotifyTargetConfigured,
    cronActive,
    logFile,
    logFileExists,
    lastRunAt,
    lastRunFresh,
    lastRunAgeSeconds,
    lastMonitorStatus: last["monitor-status"],
    lastDoctorStatus: last["doctor-status"],
    lastNotified: last.notified,
    lastIssueCount,
  };
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
    } else if (arg === "--max-age-minutes") {
      result.maxAgeMinutes = parsePositiveInt(args[++index], "--max-age-minutes");
    } else {
      throw new Error(`Unknown arguments: ${args.slice(index).join(" ")}`);
    }
  }
  return result;
}
