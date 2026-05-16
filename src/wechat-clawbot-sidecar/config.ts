import * as fs from "fs";
import * as path from "path";

import type { WechatClawbotSidecarConfig } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 26322;

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

  const stateFile =
    stringValue(raw.stateFile) ??
    stringValue(env.HIBOSS_WECHAT_CLAWBOT_STATE_FILE) ??
    path.join(process.cwd(), ".wechat-clawbot-sidecar", "state.json");

  const allowNonLocalBind =
    boolValue(raw.allowNonLocalBind) ??
    boolValue(env.HIBOSS_WECHAT_CLAWBOT_ALLOW_NON_LOCAL_BIND) ??
    false;

  const config: WechatClawbotSidecarConfig = {
    host: stringValue(raw.host) ?? stringValue(env.HIBOSS_WECHAT_CLAWBOT_HOST) ?? DEFAULT_HOST,
    port: numberValue(raw.port) ?? numberValue(env.HIBOSS_WECHAT_CLAWBOT_PORT) ?? DEFAULT_PORT,
    stateFile,
    apiTokenEnv: stringValue(raw.apiTokenEnv) ?? stringValue(env.HIBOSS_WECHAT_CLAWBOT_API_TOKEN_ENV),
    apiTokenFile: stringValue(raw.apiTokenFile) ?? stringValue(env.HIBOSS_WECHAT_CLAWBOT_API_TOKEN_FILE),
    mockIngestEnabled:
      boolValue(raw.mockIngestEnabled) ??
      boolValue(env.HIBOSS_WECHAT_CLAWBOT_MOCK_INGEST) ??
      false,
    allowNonLocalBind,
    defaultAccount: stringValue(raw.defaultAccount) ?? stringValue(env.HIBOSS_WECHAT_CLAWBOT_DEFAULT_ACCOUNT),
  };

  if (config.port < 0 || config.port > 65535) {
    throw new Error("Invalid sidecar port");
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
