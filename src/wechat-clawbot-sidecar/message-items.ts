import type { StoredWechatClawbotInReplyTo } from "./types.js";

const QUOTE_CONTAINER_KEYS = ["ref_msg", "quote_item", "reply_msg", "quoted_msg"];
const QUOTE_MESSAGE_KEYS = ["message_item", "messageItem", "message", "msg"];
const QUOTE_TEXT_MAX_CHARS = 1200;

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

function textFromItemRecord(record: Record<string, unknown>): string | undefined {
  const itemType = stringField(record, "type", "item_type", "itemType")?.toUpperCase();
  const numericType = numberField(record, "type");
  const textItem = record.text_item && typeof record.text_item === "object"
    ? record.text_item as Record<string, unknown>
    : {};
  const text = stringField(record, "text", "content") ?? stringField(textItem, "text");
  if (text && (!itemType || itemType === "TEXT" || numericType === 1)) return text;
  return undefined;
}

function truncateText(text: string): string {
  if (text.length <= QUOTE_TEXT_MAX_CHARS) return text;
  return `${text.slice(0, QUOTE_TEXT_MAX_CHARS)}...`;
}

export function textFromItemList(raw: unknown): string | undefined {
  const items = Array.isArray(raw) ? raw : [];
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const text = textFromItemRecord(item as Record<string, unknown>);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function objectValue(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

function quotedMessageRecord(item: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of QUOTE_CONTAINER_KEYS) {
    const container = objectValue(item, [key]);
    if (!container) continue;
    const message = objectValue(container, QUOTE_MESSAGE_KEYS);
    return message ? { ...container, ...message } : container;
  }
  return undefined;
}

function quotedText(record: Record<string, unknown>): string | undefined {
  const direct = textFromItemRecord(record);
  if (direct) return direct;
  const nestedItems = record.item_list ?? record.itemList;
  return textFromItemList(nestedItems);
}

function sourceType(record: Record<string, unknown>): string | number | undefined {
  const value = record.type ?? record.item_type ?? record.itemType;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return stringField(record, "type", "item_type", "itemType");
}

export function inReplyToFromItemList(raw: unknown): StoredWechatClawbotInReplyTo | undefined {
  const items = Array.isArray(raw) ? raw : [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const quoted = quotedMessageRecord(item as Record<string, unknown>);
    if (!quoted) continue;

    const text = quotedText(quoted);
    const sourceMessageId = stringField(quoted, "source_message_id", "sourceMessageId", "message_id", "messageId");
    const sourceCreateTimeMs = numberField(quoted, "create_time_ms", "createTimeMs", "create_time", "createTime");
    const type = sourceType(quoted);
    if (!text && !sourceMessageId && sourceCreateTimeMs === undefined && type === undefined) continue;

    return {
      ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
      ...(text ? { text: truncateText(text) } : {}),
      ...(sourceCreateTimeMs !== undefined ? { source_create_time_ms: sourceCreateTimeMs } : {}),
      ...(type !== undefined ? { source_type: type } : {}),
    };
  }
  return undefined;
}
