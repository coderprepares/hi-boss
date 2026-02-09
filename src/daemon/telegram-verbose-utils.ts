import type { Envelope } from "../envelope/types.js";

export const TELEGRAM_STATUS_MESSAGE_MIN_INTERVAL_MS = 1000;

export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(-maxChars);
  return `...${text.slice(-(maxChars - 3))}`;
}

export function redactSensitiveText(text: string): string {
  return text.replace(
    /(token|api[_-]?key|secret|password|passcode|authorization|bearer)\s*[:=]\s*([^\s]+)/gi,
    (_match, key) => `${key}: ***`
  );
}

export function getRuntimeMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const text = (message as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

export function extractChatIdFromEnvelope(envelope: Envelope): string | null {
  if (!envelope.metadata || typeof envelope.metadata !== "object") return null;
  const metadata = envelope.metadata as Record<string, unknown>;
  const chat = metadata.chat;
  if (!chat || typeof chat !== "object") return null;
  const chatId = (chat as { id?: unknown }).id;
  return typeof chatId === "string" ? chatId : null;
}

export function isTelegramChannelEnvelope(envelope: Envelope): boolean {
  return envelope.from.startsWith("channel:telegram:");
}

export function getSingleTelegramChatId(envelopes: Envelope[]): string | null {
  const chatIds = new Set<string>();
  for (const envelope of envelopes) {
    if (!isTelegramChannelEnvelope(envelope)) continue;
    const chatId = extractChatIdFromEnvelope(envelope);
    if (!chatId) continue;
    chatIds.add(chatId);
    if (chatIds.size > 1) return null;
  }

  const first = chatIds.values().next();
  return first.done ? null : first.value;
}

export function isHiBossEnvelopeToolCall(event: Record<string, unknown>): boolean {
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  if (toolName !== "Bash") return false;

  const command =
    typeof event.command === "string"
      ? event.command
      : event.input && typeof event.input === "object" && typeof (event.input as Record<string, unknown>).command === "string"
        ? String((event.input as Record<string, unknown>).command)
        : "";

  return /(^|\s)hiboss\s+envelope(\s|$)/i.test(command);
}

export function summarizeToolValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function compactInlineText(text: string, maxChars = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  if (maxChars <= 3) return compact.slice(0, maxChars);
  return `${compact.slice(0, maxChars - 3)}...`;
}

function extractToolInputSummary(event: Record<string, unknown>): string | null {
  const direct =
    (typeof event.query === "string" ? event.query : null) ??
    (typeof event.command === "string" ? event.command : null) ??
    (typeof event.cmd === "string" ? event.cmd : null) ??
    (typeof event.text === "string" ? event.text : null);

  if (direct && direct.trim()) {
    return compactInlineText(direct);
  }

  const input = event.input;
  if (!input) return null;

  if (typeof input === "string" && input.trim()) {
    return compactInlineText(input);
  }

  if (typeof input !== "object") return null;
  const inputRecord = input as Record<string, unknown>;

  for (const key of ["query", "command", "cmd", "text", "path", "url", "prompt", "sql"]) {
    const value = inputRecord[key];
    if (typeof value === "string" && value.trim()) {
      return compactInlineText(value);
    }
  }

  const summary = summarizeToolValue(inputRecord);
  if (!summary) return null;
  return compactInlineText(summary);
}

export function buildToolDetail(event: Record<string, unknown>): string | null {
  const keys = ["input", "arguments", "args", "toolInput", "parameters", "payload", "command", "code", "query"];
  for (const key of keys) {
    if (!(key in event)) continue;
    const value = summarizeToolValue(event[key]);
    if (!value) continue;
    if (key === "command" || key === "code" || key === "query") {
      return value;
    }
    return `${key}:\n${value}`;
  }
  return null;
}

export type VerboseStatusType = "thinking" | "assistant" | "tool" | "event";

export function verboseIcon(type: VerboseStatusType): string {
  switch (type) {
    case "thinking":
      return "💭";
    case "assistant":
      return "🤖";
    case "tool":
      return "🛠️";
    case "event":
      return "📡";
  }
}

export function renderVerboseStatusLine(type: VerboseStatusType, text: string): string {
  const normalized = text.trim();
  if (!normalized) return "";
  const redacted = redactSensitiveText(normalized);
  return `${verboseIcon(type)} ${redacted}`;
}

export function buildVerboseToolMessage(event: Record<string, unknown>): string {
  const toolName = typeof event.toolName === "string" ? event.toolName.trim() : "tool";
  const summary = extractToolInputSummary(event);
  if (!summary) return toolName;
  return `${toolName} ${redactSensitiveText(summary)}`;
}
