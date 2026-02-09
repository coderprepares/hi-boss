import type { ChatAdapter } from "../adapters/types.js";
import { TelegramAdapter } from "../adapters/telegram.adapter.js";
import type { TelegramStatusMessage } from "../adapters/telegram/status-message.js";
import { TELEGRAM_MAX_TEXT_CHARS } from "../adapters/telegram/shared.js";
import type { AgentRunStatusReporter } from "../agent/executor.js";
import type { Agent } from "../agent/types.js";
import type { Envelope } from "../envelope/types.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import type { HiBossDatabase } from "./db/database.js";
import { getTelegramStatusMessageEnabled } from "./telegram-status-config.js";
import {
  buildVerboseToolMessage,
  getRuntimeMessageText,
  getSingleTelegramChatId,
  isHiBossEnvelopeToolCall,
  renderVerboseStatusLine,
  summarizeToolValue,
  type VerboseStatusType,
} from "./telegram-verbose-utils.js";

type LiveStreamState = {
  type: VerboseStatusType;
  message: TelegramStatusMessage;
  started: boolean;
  finished: boolean;
  text: string;
};

type ToolStreamState = {
  key: string;
  callId?: string;
  baseText: string;
  stream: LiveStreamState;
};

const TOOL_COMPLETION_MAX_CHARS = 180;

function compactToolCompletionText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= TOOL_COMPLETION_MAX_CHARS) return compact;
  if (TOOL_COMPLETION_MAX_CHARS <= 3) return compact.slice(0, TOOL_COMPLETION_MAX_CHARS);
  return `${compact.slice(0, TOOL_COMPLETION_MAX_CHARS - 3)}...`;
}

function buildToolCompletionSummary(eventRecord: Record<string, unknown>, kind: "result" | "error"): string {
  const output = eventRecord.output;

  const outputContent =
    output && typeof output === "object" && typeof (output as Record<string, unknown>).content === "string"
      ? String((output as Record<string, unknown>).content)
      : null;

  const rawValue =
    kind === "result"
      ? outputContent ?? output
      : eventRecord.error ?? eventRecord.message ?? outputContent ?? output;
  const summary = summarizeToolValue(rawValue);
  if (!summary) {
    return kind === "result" ? "✅ done" : "❌ error";
  }
  const compact = compactToolCompletionText(summary);
  return kind === "result" ? `✅ ${compact}` : `❌ ${compact}`;
}

function createLiveStream(adapter: TelegramAdapter, chatId: string, type: VerboseStatusType): LiveStreamState {
  return {
    type,
    message: adapter.createStatusMessage(chatId, {
      minIntervalMs: 200,
      maxChars: TELEGRAM_MAX_TEXT_CHARS,
    }),
    started: false,
    finished: false,
    text: "",
  };
}

function updateLiveStream(state: LiveStreamState, text: string): void {
  if (state.finished) return;

  state.text = text;
  const line = renderVerboseStatusLine(state.type, state.text);
  if (!line) return;

  if (!state.started) {
    state.message.start(line);
    state.started = true;
    return;
  }

  state.message.update(line);
}

function finishLiveStream(state: LiveStreamState, text?: string): void {
  if (state.finished) return;

  if (typeof text === "string") {
    state.text = text;
  }

  const line = renderVerboseStatusLine(state.type, state.text);
  if (!line) {
    state.finished = true;
    return;
  }

  if (!state.started) {
    state.message.start(line);
    state.started = true;
  }

  state.message.finish(line);
  state.finished = true;
}

function sendVerboseMessage(params: {
  adapter: TelegramAdapter;
  chatId: string;
  agentName: string;
  type: VerboseStatusType;
  text: string;
}): void {
  const line = renderVerboseStatusLine(params.type, params.text);
  if (!line) return;
  void params.adapter.sendMessage(params.chatId, { text: line }, { parseMode: "plain" }).catch((err) => {
    logEvent("warn", "telegram-verbose-message-failed", {
      "agent-name": params.agentName,
      "chat-id": params.chatId,
      "message-type": params.type,
      error: errorMessage(err),
    });
  });
}

export function createTelegramRunStatusReporter(params: {
  db: HiBossDatabase;
  adapters: Map<string, ChatAdapter>;
  agent: Agent;
  envelopes: Envelope[];
}): AgentRunStatusReporter | undefined {
  const chatId = getSingleTelegramChatId(params.envelopes);
  if (!chatId) return undefined;

  const binding = params.db.getAgentBindingByType(params.agent.name, "telegram");
  if (!binding) return undefined;

  const adapter = params.adapters.get(binding.adapterToken);
  if (!adapter || !(adapter instanceof TelegramAdapter)) return undefined;

  if (!getTelegramStatusMessageEnabled(params.db, chatId)) return undefined;

  const typing = adapter.createTypingIndicator(chatId);

  let modelInteractionActive = false;
  let thinkingText = "";
  let assistantText = "";
  let anonymousToolCounter = 0;
  let thinkingStream: LiveStreamState | null = null;
  let assistantStream: LiveStreamState | null = null;
  const toolStreams = new Map<string, ToolStreamState>();
  const toolOrder: string[] = [];

  const ensureThinkingStream = (): LiveStreamState => {
    if (!thinkingStream || thinkingStream.finished) {
      thinkingStream = createLiveStream(adapter, chatId, "thinking");
    }
    return thinkingStream;
  };

  const ensureAssistantStream = (): LiveStreamState => {
    if (!assistantStream || assistantStream.finished) {
      assistantStream = createLiveStream(adapter, chatId, "assistant");
    }
    return assistantStream;
  };

  const startModelInteraction = (): void => {
    if (modelInteractionActive) return;
    modelInteractionActive = true;
    typing.start();
  };

  const stopModelInteraction = (): void => {
    if (!modelInteractionActive) return;
    modelInteractionActive = false;
    typing.stop();
  };

  const registerToolCall = (eventRecord: Record<string, unknown>): void => {
    const callId = typeof eventRecord.callId === "string" ? eventRecord.callId : undefined;
    const key = callId ?? `__anon_tool_${anonymousToolCounter++}`;
    const existing = toolStreams.get(key);

    if (existing) {
      finishLiveStream(existing.stream);
      toolStreams.delete(key);
      const existingIndex = toolOrder.indexOf(key);
      if (existingIndex >= 0) {
        toolOrder.splice(existingIndex, 1);
      }
    }

    const baseText = buildVerboseToolMessage(eventRecord);
    const stream = createLiveStream(adapter, chatId, "tool");
    updateLiveStream(stream, baseText);

    toolStreams.set(key, {
      key,
      callId,
      baseText,
      stream,
    });
    toolOrder.push(key);
  };

  const resolveToolKeyForCompletion = (eventRecord: Record<string, unknown>): string | null => {
    const callId = typeof eventRecord.callId === "string" ? eventRecord.callId : undefined;
    if (callId && toolStreams.has(callId)) return callId;
    if (toolOrder.length > 0) return toolOrder[0];
    return null;
  };

  const completeToolCall = (eventRecord: Record<string, unknown>, kind: "result" | "error"): void => {
    const key = resolveToolKeyForCompletion(eventRecord);
    if (!key) return;

    const entry = toolStreams.get(key);
    if (!entry) return;

    const completion = buildToolCompletionSummary(eventRecord, kind);
    finishLiveStream(entry.stream, `${entry.baseText}\n${completion}`);

    toolStreams.delete(key);
    const index = toolOrder.indexOf(key);
    if (index >= 0) {
      toolOrder.splice(index, 1);
    }
  };

  const finishPendingToolStreams = (): void => {
    for (const key of [...toolOrder]) {
      const entry = toolStreams.get(key);
      if (!entry) continue;
      finishLiveStream(entry.stream);
      toolStreams.delete(key);
    }
    toolOrder.length = 0;
  };

  return {
    onEvent: (event) => {
      const eventType = event.type;

      if (eventType === "run.started") {
        startModelInteraction();
        return;
      }

      if (eventType === "assistant.reasoning.delta") {
        startModelInteraction();
        if (typeof event.textDelta === "string" && event.textDelta) {
          thinkingText += event.textDelta;
          updateLiveStream(ensureThinkingStream(), thinkingText);
        }
        return;
      }

      if (eventType === "assistant.reasoning.message") {
        startModelInteraction();
        const messageText = getRuntimeMessageText((event as { message?: unknown }).message);
        if (messageText) {
          thinkingText = messageText;
          finishLiveStream(ensureThinkingStream(), thinkingText);
        }
        return;
      }

      if (eventType === "assistant.delta") {
        startModelInteraction();
        if (typeof event.textDelta === "string" && event.textDelta) {
          assistantText += event.textDelta;
          updateLiveStream(ensureAssistantStream(), assistantText);
        }
        return;
      }

      if (eventType === "assistant.message") {
        startModelInteraction();
        const messageText = getRuntimeMessageText((event as { message?: unknown }).message);
        if (messageText) {
          assistantText = messageText;
          finishLiveStream(ensureAssistantStream(), assistantText);
        }
        return;
      }

      if (eventType === "tool.call") {
        const eventRecord = event as Record<string, unknown>;
        if (!isHiBossEnvelopeToolCall(eventRecord)) {
          registerToolCall(eventRecord);
        }
        return;
      }

      if (eventType === "tool.result") {
        completeToolCall(event as Record<string, unknown>, "result");
        return;
      }

      if (eventType === "tool.error") {
        completeToolCall(event as Record<string, unknown>, "error");
        return;
      }

      if (eventType === "run.completed") {
        if (typeof event.finalText === "string" && event.finalText) {
          assistantText = event.finalText;
          if (!assistantStream) {
            assistantStream = createLiveStream(adapter, chatId, "assistant");
            finishLiveStream(assistantStream, assistantText);
          } else if (!assistantStream.finished) {
            finishLiveStream(assistantStream, assistantText);
          }
        }
        stopModelInteraction();
      }
    },
    finish: ({ status: runStatus, error }) => {
      stopModelInteraction();

      if (thinkingStream && !thinkingStream.finished) {
        finishLiveStream(thinkingStream, thinkingText);
      }
      if (assistantStream && !assistantStream.finished) {
        finishLiveStream(assistantStream, assistantText);
      }

      finishPendingToolStreams();

      if (runStatus === "error" && error) {
        sendVerboseMessage({
          adapter,
          chatId,
          agentName: params.agent.name,
          type: "event",
          text: `run.error ${error}`,
        });
      }
    },
  };
}
