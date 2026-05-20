import type { StoredWechatClawbotReplyReference } from "./types.js";

const MAX_REF_TEXT_CHARS = 1200;
const MAX_REF_TITLE_CHARS = 120;

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

export function buildTextRefMessage(
  replyTo: StoredWechatClawbotReplyReference | undefined
): Record<string, unknown> | undefined {
  const text = replyTo?.text.trim();
  if (!replyTo || !text) return undefined;
  const quotedText = truncate(text, MAX_REF_TEXT_CHARS);
  return {
    title: truncate(text, MAX_REF_TITLE_CHARS),
    message_item: {
      type: 1,
      ...(replyTo.message_id ? { msg_id: replyTo.message_id } : {}),
      ...(replyTo.create_time_ms !== undefined ? { create_time_ms: replyTo.create_time_ms } : {}),
      text_item: { text: quotedText },
    },
  };
}
