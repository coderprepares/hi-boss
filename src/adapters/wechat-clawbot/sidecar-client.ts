import * as fs from "fs";

import type { ChannelMessage, MessageContent } from "../types.js";

export const WECHAT_CLAWBOT_PLATFORM = "wechat-clawbot";
export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface WechatClawbotAdapterConfig {
  baseUrl: string;
  tokenEnv?: string;
  tokenFile?: string;
  defaultAccount?: string;
  pollIntervalMs: number;
  requestTimeoutMs: number;
}

export interface WechatClawbotSidecarEvent {
  eventId: string;
  accountId: string;
  peerId: string;
  text: string;
  messageId?: string;
  createdAt?: string;
  peerName?: string;
  raw: unknown;
}

export interface WechatClawbotFetchUpdatesResult {
  events: WechatClawbotSidecarEvent[];
  nextCursor?: string;
}

export interface WechatClawbotTarget {
  accountId: string;
  peerId: string;
}

export interface WechatClawbotSidecarClientOptions {
  config: WechatClawbotAdapterConfig;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid wechat-clawbot baseUrl (expected http or https)");
  }
  if (url.username || url.password) {
    throw new Error("Invalid wechat-clawbot baseUrl (credentials are not allowed)");
  }
  if (url.search || url.hash) {
    throw new Error("Invalid wechat-clawbot baseUrl (query and fragment are not allowed)");
  }
  return url.toString().replace(/\/$/, "");
}

export function parseWechatClawbotAdapterToken(raw: string): WechatClawbotAdapterConfig {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Invalid wechat-clawbot adapter token");
  }

  const parsed = trimmed.startsWith("{") ? JSON.parse(trimmed) : { baseUrl: trimmed };
  const record = objectRecord(parsed, "wechat-clawbot adapter token");
  if ("apiToken" in record || "token" in record || "botToken" in record) {
    throw new Error("Invalid wechat-clawbot adapter token (store secrets in tokenEnv or tokenFile)");
  }

  const baseUrl = stringField(record, "baseUrl");
  if (!baseUrl) {
    throw new Error("Invalid wechat-clawbot adapter token (baseUrl is required)");
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    tokenEnv: stringField(record, "tokenEnv"),
    tokenFile: stringField(record, "tokenFile"),
    defaultAccount: stringField(record, "defaultAccount"),
    pollIntervalMs: numberField(record, "pollIntervalMs", DEFAULT_POLL_INTERVAL_MS),
    requestTimeoutMs: numberField(record, "requestTimeoutMs", DEFAULT_REQUEST_TIMEOUT_MS),
  };
}

export function resolveWechatClawbotApiToken(
  config: Pick<WechatClawbotAdapterConfig, "tokenEnv" | "tokenFile">,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (config.tokenEnv) {
    const value = env[config.tokenEnv]?.trim();
    if (value) return value;
  }

  if (config.tokenFile) {
    const value = fs.readFileSync(config.tokenFile, "utf8").trim();
    if (value) return value;
  }

  return undefined;
}

export function parseWechatClawbotChatId(
  chatId: string,
  defaultAccount?: string
): WechatClawbotTarget {
  const trimmed = chatId.trim();
  const slash = trimmed.indexOf("/");
  if (slash >= 0) {
    const accountId = trimmed.slice(0, slash).trim();
    const peerId = trimmed.slice(slash + 1).trim();
    if (accountId && peerId) return { accountId, peerId };
  } else if (defaultAccount && trimmed) {
    return { accountId: defaultAccount, peerId: trimmed };
  }

  throw new Error("Invalid wechat-clawbot chat id (expected <account>/<peer>)");
}

export function normalizeWechatClawbotSidecarEvent(raw: unknown): WechatClawbotSidecarEvent {
  const record = objectRecord(raw, "wechat-clawbot event");
  const eventId = stringField(record, "eventId", "event_id", "id");
  const accountId = stringField(record, "accountId", "account_id", "botId", "bot_id");
  const peerId = stringField(record, "peerId", "peer_id", "fromUserId", "from_user_id");
  const text = stringField(record, "text");

  if (!eventId || !accountId || !peerId || !text) {
    throw new Error("Invalid wechat-clawbot event (eventId, accountId, peerId, text are required)");
  }

  return {
    eventId,
    accountId,
    peerId,
    text,
    messageId: stringField(record, "messageId", "message_id", "msgId", "msg_id"),
    createdAt: stringField(record, "createdAt", "created_at"),
    peerName: stringField(record, "peerName", "peer_name", "displayName", "display_name"),
    raw,
  };
}

export function buildWechatClawbotChannelMessage(event: WechatClawbotSidecarEvent): ChannelMessage {
  return {
    id: event.eventId,
    platform: WECHAT_CLAWBOT_PLATFORM,
    author: {
      id: event.peerId,
      displayName: event.peerName ?? event.peerId,
    },
    chat: {
      id: `${event.accountId}/${event.peerId}`,
      name: event.peerName,
    },
    content: {
      text: event.text,
    },
    raw: event.raw,
  };
}

export class WechatClawbotSidecarClient {
  private fetchImpl: FetchLike;
  private env: NodeJS.ProcessEnv;

  constructor(private options: WechatClawbotSidecarClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.env = options.env ?? process.env;
  }

  async fetchUpdates(cursor?: string): Promise<WechatClawbotFetchUpdatesResult> {
    const url = new URL(`${this.options.config.baseUrl}/updates`);
    if (cursor) url.searchParams.set("cursor", cursor);

    const data = await this.fetchJson(url, { method: "GET" });
    const record = objectRecord(data, "wechat-clawbot updates response");
    const rawEvents = Array.isArray(record.events) ? record.events : [];
    return {
      events: rawEvents.map((event) => normalizeWechatClawbotSidecarEvent(event)),
      nextCursor: stringField(record, "nextCursor", "next_cursor"),
    };
  }

  async sendText(target: WechatClawbotTarget, content: MessageContent): Promise<void> {
    const text = content.text?.trim();
    if (!text) {
      throw new Error("wechat-clawbot adapter requires text content");
    }
    if (content.attachments?.length) {
      throw new Error("wechat-clawbot adapter MVP supports text-only messages");
    }

    const url = new URL(
      `${this.options.config.baseUrl}/accounts/${encodeURIComponent(target.accountId)}` +
      `/peers/${encodeURIComponent(target.peerId)}/messages`
    );

    await this.fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  private async fetchJson(url: URL, init: RequestInit): Promise<unknown> {
    const token = resolveWechatClawbotApiToken(this.options.config, this.env);
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.config.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`wechat-clawbot sidecar HTTP ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
