import type { Envelope } from "../envelope/types.js";

const MAX_LINE_CHARS = 220;
const MAX_HISTORY_LINES = 12;

export function redactSensitiveText(text: string): string {
  return text.replace(
    /(token|api[_-]?key|secret|password|passcode|authorization|bearer)\s*[:=]\s*([^\s]+)/gi,
    (_match, key) => `${key}: ***`
  );
}

function compactInlineText(text: string, maxChars = MAX_LINE_CHARS): string {
  const compact = redactSensitiveText(text).replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  if (maxChars <= 3) return compact.slice(0, maxChars);
  return `${compact.slice(0, maxChars - 3)}...`;
}

export function extractChatIdFromEnvelope(envelope: Envelope): string | null {
  if (!envelope.metadata || typeof envelope.metadata !== "object") return null;
  const metadata = envelope.metadata as Record<string, unknown>;
  const chat = metadata.chat;
  if (!chat || typeof chat !== "object") return null;
  const chatId = (chat as { id?: unknown }).id;
  return typeof chatId === "string" ? chatId : null;
}

export function extractChannelMessageIdFromEnvelope(envelope: Envelope): string | null {
  if (!envelope.metadata || typeof envelope.metadata !== "object") return null;
  const metadata = envelope.metadata as Record<string, unknown>;
  const channelMessageId = metadata.channelMessageId;
  return typeof channelMessageId === "string" ? channelMessageId : null;
}

export function isTelegramChannelEnvelope(envelope: Envelope): boolean {
  return envelope.from.startsWith("channel:telegram:");
}

export function getSingleTelegramChatContext(envelopes: Envelope[]): { chatId: string; replyToMessageId?: string } | null {
  const chatIds = new Set<string>();
  let replyToMessageId: string | undefined;

  for (const envelope of envelopes) {
    if (!isTelegramChannelEnvelope(envelope)) continue;
    const chatId = extractChatIdFromEnvelope(envelope);
    if (!chatId) continue;
    chatIds.add(chatId);
    if (chatIds.size > 1) return null;
    if (!replyToMessageId) {
      const channelMessageId = extractChannelMessageIdFromEnvelope(envelope);
      if (channelMessageId) {
        replyToMessageId = channelMessageId;
      }
    }
  }

  const first = chatIds.values().next();
  if (first.done) return null;
  return { chatId: first.value, ...(replyToMessageId ? { replyToMessageId } : {}) };
}

export function formatVerboseLine(prefix: string, text: string): string {
  const normalized = compactInlineText(text);
  if (!normalized) return "";
  return `${prefix} ${normalized}`;
}

export function buildCommandStartLine(command: string): string {
  return formatVerboseLine("🛠", `running ${command}`);
}

export function buildCommandCompleteLine(command: string, exitCode: number | null, output: string): string {
  const summary = compactInlineText(output || "(no output)", 120);
  const exit = typeof exitCode === "number" ? `exit ${exitCode}` : "completed";
  return formatVerboseLine("✅", `${command} -> ${exit}; ${summary}`);
}

export function buildItemLifecycleLine(itemType: string, phase: "started" | "completed"): string {
  return formatVerboseLine("📡", `${itemType} ${phase}`);
}

export function buildAssistantPreviewLine(text: string): string {
  return formatVerboseLine("🤖", text);
}

export function buildRunLifecycleLine(text: string, status: "info" | "success" | "cancelled" | "error" = "info"): string {
  const prefix =
    status === "success" ? "✅" : status === "cancelled" ? "⚪" : status === "error" ? "❌" : "📡";
  return formatVerboseLine(prefix, text);
}

export function extractItemType(item: unknown): string {
  if (!item || typeof item !== "object") return "item";
  const type = (item as { type?: unknown }).type;
  return typeof type === "string" && type.trim() ? type : "item";
}

export function extractCommandExecutionSummary(item: unknown): { command: string; exitCode: number | null; output: string } | null {
  if (!item || typeof item !== "object") return null;
  const typed = item as Record<string, unknown>;
  if (typed.type !== "command_execution") return null;

  const command = typeof typed.command === "string" ? typed.command : "command";
  const exitCode = typeof typed.exit_code === "number" ? typed.exit_code : null;
  const output = typeof typed.aggregated_output === "string" ? typed.aggregated_output : "";
  return { command, exitCode, output };
}

export function extractAgentMessageText(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const typed = item as Record<string, unknown>;
  if (typed.type !== "agent_message") return null;

  if (typeof typed.text === "string" && typed.text.trim()) {
    return typed.text;
  }

  const content = typed.content;
  if (!Array.isArray(content)) return null;

  const outputText = content
    .filter((part) => typeof part === "object" && part !== null)
    .filter((part) => (part as Record<string, unknown>).type === "output_text")
    .map((part) => (part as Record<string, unknown>).text)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .join("");

  return outputText.trim() ? outputText : null;
}

export function appendVerboseHistoryLine(lines: string[], line: string): string[] {
  const normalized = line.trim();
  if (!normalized) return lines;

  const next = [...lines];
  if (next[next.length - 1] === normalized) {
    return next;
  }

  next.push(normalized);
  while (next.length > MAX_HISTORY_LINES) {
    next.shift();
  }
  return next;
}
