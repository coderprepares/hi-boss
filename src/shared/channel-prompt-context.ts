import type { Envelope, EnvelopeAttachment } from "../envelope/types.js";
import { buildAttachmentPrompts, formatAttachmentsText, type AttachmentPrompt } from "./attachment-prompt.js";

export interface ChannelMetadata {
  platform: string;
  channelMessageId: string;
  author: { id: string; username?: string; displayName: string };
  chat: { id: string; name?: string };
  inReplyTo?: {
    // Prefer channelMessageId, but accept legacy messageId from older stored metadata.
    channelMessageId?: string;
    messageId?: string;
    author?: { id: string; username?: string; displayName: string };
    text?: string;
    attachments?: EnvelopeAttachment[];
  };
}

function getFromNameOverride(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const m = metadata as Record<string, unknown>;
  if (typeof m.fromName !== "string") return undefined;
  const trimmed = m.fromName.trim();
  return trimmed ? trimmed : undefined;
}

export function isChannelMetadata(metadata: unknown): metadata is ChannelMetadata {
  if (typeof metadata !== "object" || metadata === null) return false;
  const m = metadata as Record<string, unknown>;
  return (
    typeof m.platform === "string" &&
    typeof m.channelMessageId === "string" &&
    typeof m.author === "object" &&
    m.author !== null &&
    typeof (m.author as Record<string, unknown>).id === "string" &&
    typeof (m.author as Record<string, unknown>).displayName === "string" &&
    typeof m.chat === "object" &&
    m.chat !== null &&
    typeof (m.chat as Record<string, unknown>).id === "string"
  );
}

function stripBossMarkerSuffix(name: string): string {
  const trimmed = name.trim();
  return trimmed.replace(/\s\[boss\]$/, "");
}

export function withBossMarkerSuffix(name: string, fromBoss: boolean): string {
  const trimmed = name.trim();
  if (!fromBoss) return trimmed;
  if (!trimmed) return trimmed;
  if (trimmed.endsWith("[boss]")) return trimmed;
  return `${trimmed} [boss]`;
}

export interface SemanticFromResult {
  fromName: string;
  isGroup: boolean;
  groupName: string;
  authorName: string;
}

export function buildSemanticFrom(envelope: Envelope): SemanticFromResult | undefined {
  const metadata = envelope.metadata;
  const override = getFromNameOverride(metadata);
  if (override) {
    const authorName = stripBossMarkerSuffix(override);
    return {
      fromName: withBossMarkerSuffix(authorName, envelope.fromBoss),
      isGroup: false,
      groupName: "",
      authorName,
    };
  }
  if (!isChannelMetadata(metadata)) return undefined;

  const { author, chat } = metadata;
  const authorName = author.username
    ? `${author.displayName} (@${author.username})`
    : author.displayName;

  if (chat.name) {
    return {
      fromName: `group "${chat.name}"`,
      isGroup: true,
      groupName: chat.name,
      authorName,
    };
  }

  return {
    fromName: withBossMarkerSuffix(authorName, envelope.fromBoss),
    isGroup: false,
    groupName: "",
    authorName,
  };
}

export interface InReplyToPrompt {
  fromName: string;
  text: string;
  attachments: AttachmentPrompt[];
  attachmentsText: string;
}

export function buildInReplyTo(metadata: unknown): InReplyToPrompt | undefined {
  if (!isChannelMetadata(metadata)) return undefined;
  const inReplyTo = metadata.inReplyTo;
  if (!inReplyTo || typeof inReplyTo !== "object") return undefined;

  const rt = inReplyTo as Record<string, unknown>;
  const authorRaw = rt.author;
  let fromName = "";
  if (authorRaw && typeof authorRaw === "object") {
    const a = authorRaw as Record<string, unknown>;
    const displayName = typeof a.displayName === "string" ? a.displayName : "";
    const username = typeof a.username === "string" ? a.username : "";
    fromName = username ? `${displayName} (@${username})` : displayName;
  }

  const text = typeof rt.text === "string" && rt.text.trim() ? rt.text : "(none)";
  const rawAttachments = Array.isArray(rt.attachments) ? rt.attachments : [];
  const attachments = rawAttachments.flatMap((item): EnvelopeAttachment[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const source = typeof record.source === "string" && record.source.trim() ? record.source.trim() : "";
    if (!source) return [];
    const filename = typeof record.filename === "string" && record.filename.trim()
      ? record.filename.trim()
      : undefined;
    const telegramFileId = typeof record.telegramFileId === "string" && record.telegramFileId.trim()
      ? record.telegramFileId.trim()
      : undefined;
    return [{ source, filename, telegramFileId }];
  });
  return {
    fromName,
    text,
    attachments: buildAttachmentPrompts(attachments),
    attachmentsText: formatAttachmentsText(attachments),
  };
}
