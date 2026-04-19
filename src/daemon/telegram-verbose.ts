import type { ChatAdapter } from "../adapters/types.js";
import { TelegramAdapter } from "../adapters/telegram.adapter.js";
import { TELEGRAM_MAX_TEXT_CHARS } from "../adapters/telegram/shared.js";
import type { TelegramStatusMessage } from "../adapters/telegram/status-message.js";
import type { AgentRunStatusReporter } from "../agent/executor.js";
import type { RuntimeEvent } from "../agent/executor-turn.js";
import type { Agent } from "../agent/types.js";
import type { Envelope } from "../envelope/types.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import type { HiBossDatabase } from "./db/database.js";
import { getTelegramVerboseEnabled } from "./telegram-status-config.js";
import {
  appendVerboseHistoryLine,
  buildAssistantPreviewLine,
  buildCommandCompleteLine,
  buildCommandStartLine,
  buildItemLifecycleLine,
  buildRunLifecycleLine,
  extractAgentMessageText,
  extractCommandExecutionSummary,
  extractItemType,
  getSingleTelegramChatContext,
} from "./telegram-verbose-utils.js";

const STATUS_MIN_INTERVAL_MS = 400;

type VerboseState = {
  historyLines: string[];
  statusMessage: TelegramStatusMessage;
  typingIndicator: ReturnType<TelegramAdapter["createTypingIndicator"]>;
  started: boolean;
};

function renderHistory(lines: string[]): string {
  return lines.join("\n").slice(0, TELEGRAM_MAX_TEXT_CHARS);
}

function pushHistoryLine(state: VerboseState, line: string): void {
  state.historyLines = appendVerboseHistoryLine(state.historyLines, line);
  const rendered = renderHistory(state.historyLines);
  if (!rendered.trim()) return;

  if (!state.started) {
    state.statusMessage.start(rendered);
    state.started = true;
    return;
  }

  state.statusMessage.update(rendered);
}

export function createTelegramRunStatusReporter(params: {
  db: HiBossDatabase;
  adapters: Map<string, ChatAdapter>;
  agent: Agent;
  envelopes: Envelope[];
}): AgentRunStatusReporter | undefined {
  const context = getSingleTelegramChatContext(params.envelopes);
  if (!context) return undefined;

  const binding = params.db.getAgentBindingByType(params.agent.name, "telegram");
  if (!binding) return undefined;

  const adapter = params.adapters.get(binding.adapterToken);
  if (!adapter || !(adapter instanceof TelegramAdapter)) return undefined;

  if (!getTelegramVerboseEnabled(params.db, context.chatId)) return undefined;

  const state: VerboseState = {
    historyLines: [],
    statusMessage: adapter.createStatusMessage(context.chatId, {
      minIntervalMs: STATUS_MIN_INTERVAL_MS,
      maxChars: TELEGRAM_MAX_TEXT_CHARS,
      ...(context.replyToMessageId ? { replyToMessageId: context.replyToMessageId } : {}),
    }),
    typingIndicator: adapter.createTypingIndicator(context.chatId),
    started: false,
  };

  return {
    onEvent: (event: RuntimeEvent) => {
      if (event.type === "thread.started") {
        return;
      }

      if (event.type === "turn.started") {
        state.typingIndicator.start();
        pushHistoryLine(state, buildRunLifecycleLine("run started"));
        return;
      }

      if (event.type === "turn.completed") {
        state.typingIndicator.stop();
        return;
      }

      if (event.type !== "item.started" && event.type !== "item.completed") {
        return;
      }

      const item = typeof event.item === "object" && event.item !== null ? event.item : null;
      if (!item) return;

      const commandExecution = extractCommandExecutionSummary(item);
      if (commandExecution) {
        if (event.type === "item.started") {
          pushHistoryLine(state, buildCommandStartLine(commandExecution.command));
        } else {
          pushHistoryLine(
            state,
            buildCommandCompleteLine(commandExecution.command, commandExecution.exitCode, commandExecution.output),
          );
        }
        return;
      }

      const assistantText = extractAgentMessageText(item);
      if (assistantText) {
        if (event.type === "item.completed") {
          pushHistoryLine(state, buildAssistantPreviewLine(assistantText));
        }
        return;
      }

      const itemType = extractItemType(item);
      pushHistoryLine(state, buildItemLifecycleLine(itemType, event.type === "item.started" ? "started" : "completed"));
    },
    finish: ({ status, error }) => {
      state.typingIndicator.stop();

      const finalLine =
        status === "success"
          ? buildRunLifecycleLine("run completed", "success")
          : status === "cancelled"
            ? buildRunLifecycleLine(error ?? "run cancelled", "cancelled")
            : buildRunLifecycleLine(error ?? "run failed", "error");

      pushHistoryLine(state, finalLine);

      if (!state.started) return;

      try {
        state.statusMessage.finish(renderHistory(state.historyLines));
      } catch (err) {
        logEvent("warn", "telegram-verbose-finish-failed", {
          "agent-name": params.agent.name,
          "chat-id": context.chatId,
          error: errorMessage(err),
        });
      }
    },
  };
}
