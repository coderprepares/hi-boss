import { resolveWechatClawbotIlinkBotToken } from "./config.js";
import type { IlinkTextMessage, WechatClawbotIlinkAccountConfig } from "./types.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface IlinkClientOptions {
  apiBaseUrl: string;
  requestTimeoutMs: number;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function arrayField(record: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid iLink apiBaseUrl");
  }
  return url.toString().replace(/\/$/, "");
}

function textFromItemList(raw: unknown): string | undefined {
  const items = Array.isArray(raw) ? raw : [];
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const itemType = stringField(record, "type", "item_type", "itemType")?.toUpperCase();
    const text = stringField(record, "text", "content");
    if (text && (!itemType || itemType === "TEXT")) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function normalizeMessages(raw: unknown): IlinkTextMessage[] {
  const record = objectRecord(raw, "iLink getupdates response");
  const messages = arrayField(record, "message_list", "messageList", "messages", "updates");
  const result: IlinkTextMessage[] = [];

  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) continue;
    const message = rawMessage as Record<string, unknown>;
    const messageId = stringField(message, "message_id", "messageId", "id");
    const fromUserId = stringField(message, "from_user_id", "fromUserId", "from");
    const contextToken = stringField(message, "context_token", "contextToken");
    const directText = stringField(message, "text", "content");
    const text = directText ?? textFromItemList(message.item_list ?? message.itemList);
    if (!messageId || !fromUserId || !contextToken || !text) continue;
    const createTime = message.create_time_ms ?? message.createTimeMs ?? message.create_time;
    result.push({
      messageId,
      fromUserId,
      contextToken,
      text,
      createTimeMs: typeof createTime === "number" ? createTime : undefined,
    });
  }

  return result;
}

export class WechatClawbotIlinkClient {
  private apiBaseUrl: string;
  private fetchImpl: FetchLike;
  private env: NodeJS.ProcessEnv;

  constructor(private options: IlinkClientOptions) {
    this.apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.env = options.env ?? process.env;
  }

  async fetchUpdates(
    account: WechatClawbotIlinkAccountConfig,
    getUpdatesBuf: string
  ): Promise<{ messages: IlinkTextMessage[]; nextCursor: string }> {
    const data = await this.post(account, "/getupdates", {
      get_updates_buf: getUpdatesBuf,
    });
    const record = objectRecord(data, "iLink getupdates response");
    return {
      messages: normalizeMessages(record),
      nextCursor: stringField(record, "get_updates_buf", "next_get_updates_buf", "nextCursor") ?? getUpdatesBuf,
    };
  }

  async sendText(
    account: WechatClawbotIlinkAccountConfig,
    contextToken: string,
    text: string
  ): Promise<void> {
    await this.post(account, "/sendmessage", {
      context_token: contextToken,
      item_list: [{ type: "TEXT", text }],
    });
  }

  private async post(
    account: WechatClawbotIlinkAccountConfig,
    path: string,
    body: Record<string, unknown>
  ): Promise<unknown> {
    const token = resolveWechatClawbotIlinkBotToken(account, this.env);
    const headers = new Headers({
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${token}`,
    });
    if (account.xWechatUin) headers.set("X-WECHAT-UIN", account.xWechatUin);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`iLink HTTP ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
