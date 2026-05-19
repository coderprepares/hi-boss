import * as fs from "fs";
import * as path from "path";

import { resolveWechatClawbotIlinkBotToken } from "./config.js";
import {
  aesEcbPaddedSize,
  defaultWechatMediaFilename,
  downloadWechatCdnMedia,
  md5Hex,
  randomHex,
  uploadWechatCdnMedia,
  type WechatCdnMediaRef,
  type UploadedWechatMedia,
} from "./media.js";
import type {
  IlinkMessage,
  StoredWechatClawbotAttachment,
  WechatClawbotIlinkAccountConfig,
} from "./types.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface IlinkClientOptions {
  apiBaseUrl: string;
  cdnBaseUrl: string;
  mediaDir: string;
  requestTimeoutMs: number;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

const UploadMediaType = {
  IMAGE: 1,
  FILE: 3,
} as const;

const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  FILE: 4,
} as const;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

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
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
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

function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid iLink apiBaseUrl");
  }
  return url.toString().replace(/\/$/, "");
}

function detectOutboundKind(attachment: StoredWechatClawbotAttachment): "image" | "file" {
  const ext = path.extname(attachment.filename ?? attachment.source).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? "image" : "file";
}

function uploadAesKeyForMessage(aeskeyHex: string): string {
  return Buffer.from(aeskeyHex).toString("base64");
}

function randomWechatUin(): string {
  const value = String(Math.floor(Math.random() * 0x100000000));
  return Buffer.from(value).toString("base64");
}

function textFromItemList(raw: unknown): string | undefined {
  const items = Array.isArray(raw) ? raw : [];
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const itemType = stringField(record, "type", "item_type", "itemType")?.toUpperCase();
    const numericType = numberField(record, "type");
    const textItem = record.text_item && typeof record.text_item === "object"
      ? record.text_item as Record<string, unknown>
      : {};
    const text = stringField(record, "text", "content") ?? stringField(textItem, "text");
    if (text && (!itemType || itemType === "TEXT" || numericType === 1)) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function mediaRef(value: unknown): WechatCdnMediaRef | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as WechatCdnMediaRef
    : undefined;
}

async function attachmentsFromItemList(params: {
  items: unknown;
  messageId: string;
  mediaDir: string;
  fetchImpl: FetchLike;
  requestTimeoutMs: number;
}): Promise<StoredWechatClawbotAttachment[]> {
  const items = Array.isArray(params.items) ? params.items : [];
  const result: StoredWechatClawbotAttachment[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const itemType = stringField(record, "type", "item_type", "itemType")?.toUpperCase();
    const numericType = numberField(record, "type");
    const type = numericType ?? (itemType === "IMAGE" ? 2 : itemType === "FILE" ? 4 : undefined);

    if (type === 2 && record.image_item && typeof record.image_item === "object") {
      const image = record.image_item as Record<string, unknown>;
      const media = mediaRef(image.media) ?? mediaRef(image.thumb_media);
      if (!media) continue;
      const attachment = await downloadWechatCdnMedia({
        media,
        mediaDir: params.mediaDir,
        filename: defaultWechatMediaFilename({ messageId: params.messageId, itemIndex: index, kind: "image" }),
        aesKey: stringField(image, "aeskey"),
        fetchImpl: params.fetchImpl,
        requestTimeoutMs: params.requestTimeoutMs,
      });
      if (attachment) result.push(attachment);
    }

    if (type === 4 && record.file_item && typeof record.file_item === "object") {
      const file = record.file_item as Record<string, unknown>;
      const media = mediaRef(file.media);
      if (!media) continue;
      const filename = stringField(file, "file_name", "filename", "name");
      const attachment = await downloadWechatCdnMedia({
        media,
        mediaDir: params.mediaDir,
        filename: defaultWechatMediaFilename({ messageId: params.messageId, itemIndex: index, kind: "file", filename }),
        fetchImpl: params.fetchImpl,
        requestTimeoutMs: params.requestTimeoutMs,
      });
      if (attachment) result.push(attachment);
    }
  }

  return result;
}

async function normalizeMessages(params: {
  raw: unknown;
  mediaDir: string;
  fetchImpl: FetchLike;
  requestTimeoutMs: number;
}): Promise<IlinkMessage[]> {
  const record = objectRecord(params.raw, "iLink getupdates response");
  const messages = arrayField(record, "msgs", "message_list", "messageList", "messages", "updates");
  const result: IlinkMessage[] = [];

  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) continue;
    const message = rawMessage as Record<string, unknown>;
    const messageId = stringField(message, "message_id", "messageId", "id");
    const fromUserId = stringField(message, "from_user_id", "fromUserId", "from");
    const contextToken = stringField(message, "context_token", "contextToken");
    const directText = stringField(message, "text", "content");
    const itemList = message.item_list ?? message.itemList;
    const text = directText ?? textFromItemList(itemList);
    if (!messageId || !fromUserId || !contextToken) continue;
    const attachments = await attachmentsFromItemList({
      items: itemList,
      messageId,
      mediaDir: params.mediaDir,
      fetchImpl: params.fetchImpl,
      requestTimeoutMs: params.requestTimeoutMs,
    });
    if (!text && attachments.length === 0) continue;
    const createTime = message.create_time_ms ?? message.createTimeMs ?? message.create_time;
    const normalized: IlinkMessage = {
      messageId,
      fromUserId,
      contextToken,
      text,
      createTimeMs: typeof createTime === "number" ? createTime : undefined,
    };
    if (attachments.length > 0) normalized.attachments = attachments;
    result.push(normalized);
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
  ): Promise<{ messages: IlinkMessage[]; nextCursor: string }> {
    const data = await this.post(account, "/ilink/bot/getupdates", {
      get_updates_buf: getUpdatesBuf,
      base_info: {
        channel_version: "1.0.0",
      },
    });
    const record = objectRecord(data, "iLink getupdates response");
    return {
      messages: await normalizeMessages({
        raw: record,
        mediaDir: this.options.mediaDir,
        fetchImpl: this.fetchImpl,
        requestTimeoutMs: this.options.requestTimeoutMs,
      }),
      nextCursor: stringField(record, "get_updates_buf", "next_get_updates_buf", "nextCursor") ?? getUpdatesBuf,
    };
  }

  async sendText(
    account: WechatClawbotIlinkAccountConfig,
    peerId: string,
    contextToken: string,
    text: string
  ): Promise<void> {
    await this.sendMessage(account, peerId, contextToken, { text });
  }

  async getConfig(
    account: WechatClawbotIlinkAccountConfig,
    peerId: string,
    contextToken: string
  ): Promise<unknown> {
    return await this.post(account, "/ilink/bot/getconfig", {
      ilink_user_id: peerId,
      context_token: contextToken,
      base_info: {
        channel_version: "1.0.0",
      },
    });
  }

  async sendTyping(
    account: WechatClawbotIlinkAccountConfig,
    peerId: string,
    typingTicket: string,
    status: 1 | 2
  ): Promise<void> {
    await this.post(account, "/ilink/bot/sendtyping", {
      ilink_user_id: peerId,
      typing_ticket: typingTicket,
      status,
      base_info: {
        channel_version: "1.0.0",
      },
    });
  }

  async sendMessage(
    account: WechatClawbotIlinkAccountConfig,
    peerId: string,
    contextToken: string,
    content: { text?: string; attachments?: StoredWechatClawbotAttachment[] }
  ): Promise<void> {
    const text = content.text?.trim();
    const attachments = content.attachments ?? [];
    if (!text && attachments.length === 0) return;

    if (text) {
      await this.postSendMessage(account, peerId, contextToken, [{
        type: MessageItemType.TEXT,
        text_item: { text },
      }]);
    }

    for (const attachment of attachments) {
      const uploaded = await this.uploadAttachment(account, peerId, attachment);
      const kind = detectOutboundKind(attachment);
      if (kind === "image") {
        await this.postSendMessage(account, peerId, contextToken, [{
          type: MessageItemType.IMAGE,
          image_item: {
            media: {
              encrypt_query_param: uploaded.downloadEncryptedQueryParam,
              aes_key: uploadAesKeyForMessage(uploaded.aeskeyHex),
              encrypt_type: 1,
            },
            mid_size: uploaded.ciphertextSize,
          },
        }]);
      } else {
        await this.postSendMessage(account, peerId, contextToken, [{
          type: MessageItemType.FILE,
          file_item: {
            media: {
              encrypt_query_param: uploaded.downloadEncryptedQueryParam,
              aes_key: uploadAesKeyForMessage(uploaded.aeskeyHex),
              encrypt_type: 1,
            },
            file_name: path.basename(attachment.filename ?? attachment.source),
            len: String(uploaded.rawSize),
          },
        }]);
      }
    }
  }

  async uploadAttachment(
    account: WechatClawbotIlinkAccountConfig,
    peerId: string,
    attachment: StoredWechatClawbotAttachment
  ): Promise<UploadedWechatMedia> {
    const plaintext = fs.readFileSync(attachment.source);
    const rawSize = plaintext.length;
    const filekey = randomHex(16);
    const aeskeyHex = randomHex(16);
    const kind = detectOutboundKind(attachment);
    const uploadUrl = await this.post(account, "/ilink/bot/getuploadurl", {
      filekey,
      media_type: kind === "image" ? UploadMediaType.IMAGE : UploadMediaType.FILE,
      to_user_id: peerId,
      rawsize: rawSize,
      rawfilemd5: md5Hex(plaintext),
      filesize: aesEcbPaddedSize(rawSize),
      no_need_thumb: true,
      aeskey: aeskeyHex,
      base_info: {
        channel_version: "1.0.3",
      },
    });
    const record = objectRecord(uploadUrl, "iLink getuploadurl response");
    const uploaded = await uploadWechatCdnMedia({
      plaintext,
      uploadFullUrl: stringField(record, "upload_full_url", "uploadFullUrl"),
      uploadParam: stringField(record, "upload_param", "uploadParam"),
      filekey,
      cdnBaseUrl: this.options.cdnBaseUrl,
      aeskey: Buffer.from(aeskeyHex, "hex"),
      fetchImpl: this.fetchImpl,
      requestTimeoutMs: this.options.requestTimeoutMs,
    });
    return {
      filekey,
      downloadEncryptedQueryParam: uploaded.downloadEncryptedQueryParam,
      aeskeyHex,
      rawSize,
      ciphertextSize: uploaded.ciphertextSize,
      md5: md5Hex(plaintext),
    };
  }

  private async postSendMessage(
    account: WechatClawbotIlinkAccountConfig,
    peerId: string,
    contextToken: string,
    itemList: Array<Record<string, unknown>>
  ): Promise<void> {
    await this.post(account, "/ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: peerId,
        client_id: `hiboss-wechat-clawbot:${Date.now()}-${Math.random().toString(16).slice(2)}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: itemList,
      },
      base_info: {
        channel_version: "1.0.3",
      },
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
      "X-WECHAT-UIN": randomWechatUin(),
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
