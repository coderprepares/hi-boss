import { resolveWechatClawbotIlinkBotToken } from "./config.js";
import { inReplyToFromItemList, quotedMessageRecordsFromItemList, textFromItemList } from "./message-items.js";
import {
  aesEcbPaddedSize,
  defaultWechatMediaFilename,
  downloadWechatCdnMedia,
  md5Hex,
  randomHex,
  uploadWechatCdnMedia,
  type UploadedWechatMedia,
} from "./media.js";
import { attachmentsFromItemList } from "./inbound-attachments.js";
import { normalizeWechatOutboundText } from "./outbound-text.js";
import { detectOutboundKind, readOutboundAttachment, type UploadedWechatAttachment } from "./outbound-attachments.js";
import { traceRawMessageFields } from "./raw-field-trace.js";
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
  VIDEO: 2,
  FILE: 3,
} as const;

const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VIDEO: 5,
  FILE: 4,
} as const;

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

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid iLink apiBaseUrl");
  }
  return url.toString().replace(/\/$/, "");
}

function uploadAesKeyForMessage(aeskeyHex: string): string {
  return Buffer.from(aeskeyHex).toString("base64");
}

function uploadedMediaRef(uploaded: UploadedWechatMedia): Record<string, string | number> {
  return {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: uploadAesKeyForMessage(uploaded.aeskeyHex),
    encrypt_type: 1,
  };
}

function randomWechatUin(): string {
  const value = String(Math.floor(Math.random() * 0x100000000));
  return Buffer.from(value).toString("base64");
}

async function quotedAttachmentsFromItemList(params: {
  items: unknown;
  messageId: string;
  mediaDir: string;
  fetchImpl: FetchLike;
  requestTimeoutMs: number;
}): Promise<StoredWechatClawbotAttachment[]> {
  const quotedItems = quotedMessageRecordsFromItemList(params.items).flatMap((record) => {
    const nestedItems = record.item_list ?? record.itemList;
    return Array.isArray(nestedItems) ? nestedItems : [record];
  });
  if (quotedItems.length === 0) return [];

  return await attachmentsFromItemList({
    items: quotedItems,
    messageId: `${params.messageId}-quote`,
    mediaDir: params.mediaDir,
    fetchImpl: params.fetchImpl,
    requestTimeoutMs: params.requestTimeoutMs,
  });
}

async function normalizeMessages(params: {
  raw: unknown;
  mediaDir: string;
  fetchImpl: FetchLike;
  requestTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<IlinkMessage[]> {
  const record = objectRecord(params.raw, "iLink getupdates response");
  const messages = arrayField(record, "msgs", "message_list", "messageList", "messages", "updates");
  const result: IlinkMessage[] = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const rawMessage = messages[messageIndex];
    if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) continue;
    const message = rawMessage as Record<string, unknown>;
    traceRawMessageFields({ message, messageIndex, env: params.env });
    const messageId = stringField(message, "message_id", "messageId", "id");
    const fromUserId = stringField(message, "from_user_id", "fromUserId", "from");
    const contextToken = stringField(message, "context_token", "contextToken");
    const directText = stringField(message, "text", "content");
    const itemList = message.item_list ?? message.itemList;
    const text = directText ?? textFromItemList(itemList);
    const inReplyTo = inReplyToFromItemList(itemList);
    if (!messageId || !fromUserId || !contextToken) continue;
    const attachments = await attachmentsFromItemList({
      items: itemList,
      messageId,
      mediaDir: params.mediaDir,
      fetchImpl: params.fetchImpl,
      requestTimeoutMs: params.requestTimeoutMs,
    });
    const quotedAttachments = await quotedAttachmentsFromItemList({
      items: itemList,
      messageId,
      mediaDir: params.mediaDir,
      fetchImpl: params.fetchImpl,
      requestTimeoutMs: params.requestTimeoutMs,
    });
    const normalizedInReplyTo = inReplyTo || quotedAttachments.length > 0
      ? {
          ...(inReplyTo ?? {}),
          ...(quotedAttachments.length > 0 ? { attachments: quotedAttachments } : {}),
        }
      : undefined;
    if (!text && attachments.length === 0 && !normalizedInReplyTo) continue;
    const createTime = message.create_time_ms ?? message.createTimeMs ?? message.create_time;
    const normalized: IlinkMessage = {
      messageId,
      fromUserId,
      contextToken,
      text,
      createTimeMs: typeof createTime === "number" ? createTime : undefined,
    };
    if (attachments.length > 0) normalized.attachments = attachments;
    if (normalizedInReplyTo) normalized.inReplyTo = normalizedInReplyTo;
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
        env: this.env,
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
        text_item: { text: normalizeWechatOutboundText(text) },
      }]);
    }

    for (const attachment of attachments) {
      const uploaded = await this.uploadAttachment(account, peerId, attachment);
      const kind = uploaded.kind;
      const media = uploadedMediaRef(uploaded);
      if (kind === "image") {
        await this.postSendMessage(account, peerId, contextToken, [{
          type: MessageItemType.IMAGE,
          image_item: {
            media,
            mid_size: uploaded.ciphertextSize,
          },
        }]);
      } else if (kind === "video") {
        await this.postSendMessage(account, peerId, contextToken, [{
          type: MessageItemType.VIDEO,
          video_item: {
            media,
            video_size: uploaded.ciphertextSize,
          },
        }]);
      } else {
        await this.postSendMessage(account, peerId, contextToken, [{
          type: MessageItemType.FILE,
          file_item: {
            media,
            file_name: uploaded.filename,
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
  ): Promise<UploadedWechatAttachment> {
    const data = await readOutboundAttachment(attachment, {
      fetchImpl: this.fetchImpl,
      requestTimeoutMs: this.options.requestTimeoutMs,
    });
    const plaintext = data.plaintext;
    const rawSize = plaintext.length;
    const filekey = randomHex(16);
    const aeskeyHex = randomHex(16);
    const kind = detectOutboundKind({ source: data.filename, filename: data.filename });
    const uploadUrl = await this.post(account, "/ilink/bot/getuploadurl", {
      filekey,
      media_type: kind === "image" ? UploadMediaType.IMAGE :
        kind === "video" ? UploadMediaType.VIDEO : UploadMediaType.FILE,
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
      filename: data.filename,
      kind,
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
