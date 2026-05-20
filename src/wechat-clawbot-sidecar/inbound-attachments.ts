import {
  defaultWechatMediaFilename,
  downloadWechatCdnMedia,
  type WechatCdnMediaRef,
} from "./media.js";
import type { FetchLike } from "./ilink-client.js";
import type { StoredWechatClawbotAttachment } from "./types.js";

const MessageItemType = {
  IMAGE: 2,
  VOICE: 3,
  VIDEO: 5,
  FILE: 4,
} as const;

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function mediaRef(value: unknown): WechatCdnMediaRef | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as WechatCdnMediaRef
    : undefined;
}

function itemType(record: Record<string, unknown>): number | undefined {
  const rawType = stringField(record, "type", "item_type", "itemType")?.toUpperCase();
  return numberField(record, "type") ?? (
    rawType === "IMAGE" ? MessageItemType.IMAGE :
    rawType === "VIDEO" ? MessageItemType.VIDEO :
    rawType === "VOICE" ? MessageItemType.VOICE :
    rawType === "FILE" ? MessageItemType.FILE : undefined
  );
}

export async function attachmentsFromItemList(params: {
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
    const type = itemType(record);
    const kind = type === MessageItemType.IMAGE ? "image" :
      type === MessageItemType.VIDEO ? "video" :
      type === MessageItemType.VOICE ? "voice" :
      type === MessageItemType.FILE ? "file" : undefined;
    if (!kind) continue;
    const mediaItem = record[`${kind}_item`];
    if (!mediaItem || typeof mediaItem !== "object" || Array.isArray(mediaItem)) continue;
    const mediaRecord = mediaItem as Record<string, unknown>;
    const media = kind === "image"
      ? mediaRef(mediaRecord.media) ?? mediaRef(mediaRecord.thumb_media)
      : mediaRef(mediaRecord.media);
    if (!media) continue;
    const attachment = await downloadWechatCdnMedia({
      media,
      mediaDir: params.mediaDir,
      filename: defaultWechatMediaFilename({
        messageId: params.messageId,
        itemIndex: index,
        kind,
        filename: kind === "file" ? stringField(mediaRecord, "file_name", "filename", "name") : undefined,
      }),
      aesKey: stringField(mediaRecord, "aeskey", "aes_key"),
      fetchImpl: params.fetchImpl,
      requestTimeoutMs: params.requestTimeoutMs,
    });
    if (attachment) result.push(attachment);
  }

  return result;
}
