import * as fs from "fs";
import * as path from "path";
import * as qrcode from "qrcode-terminal";

import type { FetchLike } from "./ilink-client.js";

const DEFAULT_ILINK_API_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_TOKEN_DIR = "/root/hiboss/adapters/wechat-clawbot";

interface LoginOptions {
  configPath?: string;
  apiBaseUrl?: string;
  tokenDir?: string;
  requestTimeoutMs?: number;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: FetchLike;
  renderQr?: (content: string) => void;
}

interface LoginResult {
  accountId: string;
  tokenFile: string;
  ilinkUserId?: string;
}

function normalizeBaseUrl(raw: string): string {
  return new URL(raw).toString().replace(/\/$/, "");
}

function randomWechatUin(): string {
  return String(Math.floor(1000000000 + Math.random() * 8999999999));
}

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid sidecar config JSON");
  }
  return parsed as Record<string, unknown>;
}

function writeJsonFile0600(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function writeTokenFile(filePath: string, token: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function mergeAccount(config: Record<string, unknown>, accountId: string, tokenFile: string): Record<string, unknown> {
  const accounts = Array.isArray(config.ilinkAccounts)
    ? config.ilinkAccounts.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown>[]
    : [];
  const next = accounts.filter((account) => account.accountId !== accountId && account.account_id !== accountId);
  next.push({ accountId, botTokenFile: tokenFile });
  return {
    ...config,
    transport: "ilink",
    ilinkAccounts: next,
  };
}

async function fetchJson(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`iLink login HTTP ${response.status}`);
  const parsed = await response.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid iLink login response");
  }
  return parsed as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWechatClawbotLogin(options: LoginOptions = {}): Promise<LoginResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl ?? process.env.HIBOSS_WECHAT_CLAWBOT_ILINK_API_BASE_URL ?? DEFAULT_ILINK_API_BASE_URL);
  const tokenDir = options.tokenDir ?? process.env.HIBOSS_WECHAT_CLAWBOT_TOKEN_DIR ?? DEFAULT_TOKEN_DIR;
  const requestTimeoutMs = options.requestTimeoutMs ?? 35000;
  const maxWaitMs = options.maxWaitMs ?? 180000;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;

  const qrResponse = await fetchJson(fetchImpl, `${apiBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`);
  const qrcodeId = stringField(qrResponse, "qrcode");
  const qrContent = stringField(qrResponse, "qrcode_img_content", "qrcodeImgContent") ?? qrcodeId;
  if (!qrcodeId || !qrContent) throw new Error("Invalid QR login response");

  const renderQr = options.renderQr ?? ((content: string) => qrcode.generate(content, { small: true }));
  renderQr(qrContent);
  console.log("Scan the QR code with WeChat, then confirm login on your phone.");

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const url = `${apiBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const status = await fetchJson(fetchImpl, url, {
        headers: {
          AuthorizationType: "ilink_bot_token",
          "iLink-App-ClientVersion": "1",
          "X-WECHAT-UIN": randomWechatUin(),
        },
        signal: controller.signal,
      });
      const statusText = stringField(status, "status");
      if (statusText === "scaned") {
        console.log("Scanned. Please confirm on your phone.");
      } else if (statusText === "expired") {
        throw new Error("QR code expired; run login again");
      } else if (statusText === "confirmed") {
        const botToken = stringField(status, "bot_token", "botToken");
        const accountId = stringField(status, "ilink_bot_id", "ilinkBotId");
        const ilinkUserId = stringField(status, "ilink_user_id", "ilinkUserId");
        if (!botToken || !accountId) throw new Error("Invalid confirmed login response");

        const tokenFile = path.join(tokenDir, `${accountId}.bot-token`);
        writeTokenFile(tokenFile, botToken);
        if (options.configPath) {
          writeJsonFile0600(options.configPath, mergeAccount(readJsonFile(options.configPath), accountId, tokenFile));
        }
        console.log(`Login confirmed. Account ${accountId} saved to ${tokenFile}`);
        return { accountId, tokenFile, ilinkUserId };
      }
    } finally {
      clearTimeout(timeout);
    }
    await sleep(pollIntervalMs);
  }

  throw new Error("QR login timed out");
}
