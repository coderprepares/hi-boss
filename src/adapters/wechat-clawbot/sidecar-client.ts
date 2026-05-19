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
  text?: string;
  attachments?: Array<{ source: string; filename?: string }>;
  inReplyTo?: ChannelMessage["inReplyTo"];
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

export interface WechatClawbotConfigResult {
  ok?: boolean;
  accountId?: string;
  peerId?: string;
  config: unknown;
  raw: unknown;
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

function normalizeInReplyTo(record: Record<string, unknown>): ChannelMessage["inReplyTo"] | undefined {
  const raw = record.inReplyTo ?? record.in_reply_to;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const reply = raw as Record<string, unknown>;
  const channelMessageId = stringField(reply, "channelMessageId", "channel_message_id", "messageId", "message_id");
  const text = stringField(reply, "text");
  const rawAuthor = reply.author;
  const author = rawAuthor && typeof rawAuthor === "object" && !Array.isArray(rawAuthor)
    ? (() => {
        const authorRecord = rawAuthor as Record<string, unknown>;
        const id = stringField(authorRecord, "id");
        const displayName = stringField(authorRecord, "displayName", "display_name");
        if (!id || !displayName) return undefined;
        return {
          id,
          username: stringField(authorRecord, "username"),
          displayName,
        };
      })()
    : undefined;

  if (!channelMessageId && !text && !author) return undefined;
  return {
    ...(channelMessageId ? { channelMessageId } : {}),
    ...(author ? { author } : {}),
    ...(text ? { text } : {}),
  };
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
  const rawAttachments = Array.isArray(record.attachments) ? record.attachments : [];
  const attachments = rawAttachments.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const source = stringField(item as Record<string, unknown>, "source");
    if (!source) return [];
    const filename = stringField(item as Record<string, unknown>, "filename");
    return [{ source, filename }];
  });

  if (!eventId || !accountId || !peerId || (!text && attachments.length === 0)) {
    throw new Error("Invalid wechat-clawbot event (eventId, accountId, peerId, and text or attachments are required)");
  }

  return {
    eventId,
    accountId,
    peerId,
    text,
    attachments: attachments.length > 0 ? attachments : undefined,
    inReplyTo: normalizeInReplyTo(record),
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
    ...(event.inReplyTo ? { inReplyTo: event.inReplyTo } : {}),
    content: {
      text: event.text,
      attachments: event.attachments,
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
    const attachments = content.attachments ?? [];
    if (!text && attachments.length === 0) {
      throw new Error("wechat-clawbot adapter requires text or attachments");
    }

    const url = new URL(
      `${this.options.config.baseUrl}/accounts/${encodeURIComponent(target.accountId)}` +
      `/peers/${encodeURIComponent(target.peerId)}/messages`
    );

    await this.fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(text ? { text } : {}),
        ...(attachments.length > 0
          ? {
              attachments: attachments.map((attachment) => ({
                source: attachment.source,
                filename: attachment.filename,
              })),
            }
          : {}),
      }),
    });
  }

  async getConfig(target: WechatClawbotTarget): Promise<WechatClawbotConfigResult> {
    const url = new URL(
      `${this.options.config.baseUrl}/accounts/${encodeURIComponent(target.accountId)}` +
      `/peers/${encodeURIComponent(target.peerId)}/config`
    );
    const data = await this.fetchJson(url, { method: "GET" });
    const record = objectRecord(data, "wechat-clawbot config response");
    return {
      ok: record.ok === true,
      accountId: stringField(record, "accountId", "account_id"),
      peerId: stringField(record, "peerId", "peer_id"),
      config: "config" in record ? record.config : record,
      raw: data,
    };
  }

  async sendTyping(target: WechatClawbotTarget, status: 1 | 2 = 1): Promise<void> {
    const url = new URL(
      `${this.options.config.baseUrl}/accounts/${encodeURIComponent(target.accountId)}` +
      `/peers/${encodeURIComponent(target.peerId)}/typing`
    );
    await this.fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
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
        const body = await response.text().catch(() => "");
        let message = body.trim();
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          message = stringField(parsed, "message", "error") ?? message;
        } catch {
          // Keep plain response text.
        }
        throw new Error(
          message
            ? `wechat-clawbot sidecar HTTP ${response.status}: ${message}`
            : `wechat-clawbot sidecar HTTP ${response.status}`
        );
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
