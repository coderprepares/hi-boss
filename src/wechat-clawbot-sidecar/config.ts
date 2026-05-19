import * as fs from "fs";
import * as path from "path";

import type { WechatClawbotSidecarConfig } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 26322;
const DEFAULT_ILINK_API_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_ILINK_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return undefined;
}

function boolValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function objectArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value.map((item) => objectRecord(item, label));
}

function assertLocalBind(host: string, allowNonLocalBind: boolean): void {
  const normalized = host.toLowerCase();
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!localHosts.has(normalized) && !allowNonLocalBind) {
    throw new Error("Refusing non-local sidecar bind without allowNonLocalBind=true");
  }
}

export function loadWechatClawbotSidecarConfig(
  configPath?: string,
  env: NodeJS.ProcessEnv = process.env
): WechatClawbotSidecarConfig {
  const raw = configPath
    ? objectRecord(JSON.parse(fs.readFileSync(configPath, "utf8")), "wechat-clawbot sidecar config")
    : {};

  if ("apiToken" in raw || "token" in raw || "botToken" in raw || "contextToken" in raw) {
    throw new Error("Do not store sidecar API tokens inline; use apiTokenEnv or apiTokenFile");
  }
  const rawIlinkAccounts = objectArray(raw.ilinkAccounts, "ilinkAccounts");
  for (const account of rawIlinkAccounts) {
    if ("botToken" in account || "token" in account || "contextToken" in account) {
      throw new Error("Do not store iLink tokens inline; use botTokenEnv or botTokenFile");
    }
  }

  const stateFile =
    stringValue(raw.stateFile) ??
    stringValue(env.HIBOSS_WECHAT_CLAWBOT_STATE_FILE) ??
    path.join(process.cwd(), ".wechat-clawbot-sidecar", "state.json");
  const mediaDir =
    stringValue(raw.mediaDir) ??
    stringValue(env.HIBOSS_WECHAT_CLAWBOT_MEDIA_DIR) ??
    path.join(path.dirname(stateFile), "media");

  const allowNonLocalBind =
    boolValue(raw.allowNonLocalBind) ??
    boolValue(env.HIBOSS_WECHAT_CLAWBOT_ALLOW_NON_LOCAL_BIND) ??
    false;

  const config: WechatClawbotSidecarConfig = {
    host: stringValue(raw.host) ?? stringValue(env.HIBOSS_WECHAT_CLAWBOT_HOST) ?? DEFAULT_HOST,
    port: numberValue(raw.port) ?? numberValue(env.HIBOSS_WECHAT_CLAWBOT_PORT) ?? DEFAULT_PORT,
    stateFile,
    mediaDir,
    transport:
      stringValue(raw.transport) === "ilink" || stringValue(env.HIBOSS_WECHAT_CLAWBOT_TRANSPORT) === "ilink"
        ? "ilink"
        : "mock",
    apiTokenEnv: stringValue(raw.apiTokenEnv) ?? stringValue(env.HIBOSS_WECHAT_CLAWBOT_API_TOKEN_ENV),
    apiTokenFile: stringValue(raw.apiTokenFile) ?? stringValue(env.HIBOSS_WECHAT_CLAWBOT_API_TOKEN_FILE),
    mockIngestEnabled:
      boolValue(raw.mockIngestEnabled) ??
      boolValue(env.HIBOSS_WECHAT_CLAWBOT_MOCK_INGEST) ??
      false,
    allowNonLocalBind,
    defaultAccount: stringValue(raw.defaultAccount) ?? stringValue(env.HIBOSS_WECHAT_CLAWBOT_DEFAULT_ACCOUNT),
    pollIntervalMs: numberValue(raw.pollIntervalMs) ?? numberValue(env.HIBOSS_WECHAT_CLAWBOT_POLL_INTERVAL_MS) ?? 2000,
    requestTimeoutMs: numberValue(raw.requestTimeoutMs) ?? numberValue(env.HIBOSS_WECHAT_CLAWBOT_REQUEST_TIMEOUT_MS) ?? 35000,
    ilinkApiBaseUrl:
      stringValue(raw.ilinkApiBaseUrl) ??
      stringValue(env.HIBOSS_WECHAT_CLAWBOT_ILINK_API_BASE_URL) ??
      DEFAULT_ILINK_API_BASE_URL,
    ilinkCdnBaseUrl:
      stringValue(raw.ilinkCdnBaseUrl) ??
      stringValue(env.HIBOSS_WECHAT_CLAWBOT_ILINK_CDN_BASE_URL) ??
      DEFAULT_ILINK_CDN_BASE_URL,
    ilinkAccounts: rawIlinkAccounts.map((account) => ({
      accountId: stringValue(account.accountId) ?? stringValue(account.account_id) ?? "",
      botTokenEnv: stringValue(account.botTokenEnv) ?? stringValue(account.bot_token_env),
      botTokenFile: stringValue(account.botTokenFile) ?? stringValue(account.bot_token_file),
      xWechatUin: stringValue(account.xWechatUin) ?? stringValue(account.x_wechat_uin),
    })),
  };

  if (config.port < 0 || config.port > 65535) {
    throw new Error("Invalid sidecar port");
  }
  if (config.pollIntervalMs < 250) {
    throw new Error("Invalid sidecar pollIntervalMs (must be >= 250)");
  }
  if (config.requestTimeoutMs < 1000) {
    throw new Error("Invalid sidecar requestTimeoutMs (must be >= 1000)");
  }
  if (config.transport === "ilink") {
    if (config.ilinkAccounts.length === 0) throw new Error("iLink transport requires ilinkAccounts");
    for (const account of config.ilinkAccounts) {
      if (!account.accountId) throw new Error("iLink account requires accountId");
      if (!account.botTokenEnv && !account.botTokenFile) {
        throw new Error("iLink account requires botTokenEnv or botTokenFile");
      }
    }
  }
  assertLocalBind(config.host, config.allowNonLocalBind);
  return config;
}

export function resolveWechatClawbotSidecarApiToken(
  config: Pick<WechatClawbotSidecarConfig, "apiTokenEnv" | "apiTokenFile">,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (config.apiTokenEnv) {
    const token = env[config.apiTokenEnv]?.trim();
    if (token) return token;
  }
  if (config.apiTokenFile) {
    const token = fs.readFileSync(config.apiTokenFile, "utf8").trim();
    if (token) return token;
  }
  return undefined;
}

export function resolveWechatClawbotIlinkBotToken(
  config: { botTokenEnv?: string; botTokenFile?: string },
  env: NodeJS.ProcessEnv = process.env
): string {
  if (config.botTokenEnv) {
    const token = env[config.botTokenEnv]?.trim();
    if (token) return token;
  }
  if (config.botTokenFile) {
    const token = fs.readFileSync(config.botTokenFile, "utf8").trim();
    if (token) return token;
  }
  throw new Error("Missing iLink bot token");
}

export function parseSidecarCliArgs(argv: string[]): { configPath?: string; overrides: string[] } {
  const overrides: string[] = [];
  let configPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      configPath = argv[++index];
    } else {
      overrides.push(arg);
    }
  }

  return { configPath, overrides };
}
