import { parseTelegramMessageId } from "../../shared/telegram-message-id.js";
import { errorMessage, isDaemonDebugEnabled, logEvent } from "../../shared/daemon-log.js";
import { isReplyToMessageNotFound, TELEGRAM_MAX_TEXT_CHARS, truncateText } from "./shared.js";

type TelegramStatusApi = {
  sendMessage: (chatId: string, text: string, extra?: unknown) => Promise<unknown>;
  callApi: (method: string, payload: unknown) => Promise<unknown>;
};

export interface TelegramStatusMessageOptions {
  replyToMessageId?: string;
  minIntervalMs?: number;
  maxChars?: number;
  parseMode?: "MarkdownV2" | "HTML";
}

const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_MAX_CHARS = 3000;

function redactSensitive(text: string): string {
  return text.replace(
    /(token|api[_-]?key|secret|password|passcode|authorization|bearer)\s*[:=]\s*([^\s]+)/gi,
    (_match, key) => `${key}: ***`
  );
}

export class TelegramStatusMessage {
  private telegram: TelegramStatusApi;
  private chatId: string;
  private replyToMessageId?: string;
  private messageId?: number;
  private startPromise: Promise<void> | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private pendingText: string | null = null;
  private lastSentText: string | null = null;
  private lastSentAtMs = 0;
  private sending = false;
  private finished = false;
  private disabled = false;
  private minIntervalMs: number;
  private maxChars: number;
  private parseMode?: "MarkdownV2" | "HTML";

  constructor(telegram: TelegramStatusApi, chatId: string, options: TelegramStatusMessageOptions = {}) {
    this.telegram = telegram;
    this.chatId = chatId;
    this.replyToMessageId = options.replyToMessageId;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.parseMode = options.parseMode;
  }

  start(text: string): void {
    if (this.finished || this.disabled || this.startPromise) return;
    const normalized = this.normalizeText(text);
    if (!normalized) return;
    this.startPromise = this.sendInitial(normalized);
  }

  update(text: string): void {
    if (this.finished || this.disabled) return;
    const normalized = this.normalizeText(text);
    if (!normalized) return;

    if (!this.startPromise) {
      this.start(normalized);
      return;
    }

    if (normalized === this.lastSentText || normalized === this.pendingText) return;

    if (this.sending) {
      this.pendingText = normalized;
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastSentAtMs;
    if (elapsed >= this.minIntervalMs && !this.pendingTimer) {
      void this.sendUpdate(normalized);
      return;
    }

    this.pendingText = normalized;
    if (!this.pendingTimer) {
      const delay = Math.max(this.minIntervalMs - elapsed, 0);
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        const pending = this.pendingText;
        this.pendingText = null;
        if (pending) {
          void this.sendUpdate(pending);
        }
      }, delay);
    }
  }

  finish(text: string): void {
    if (this.disabled || this.finished) return;
    const normalized = this.normalizeText(text);
    if (!normalized) return;

    this.finished = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.pendingText = null;

    if (!this.startPromise) {
      this.startPromise = this.sendInitial(normalized);
      return;
    }

    void this.sendUpdate(normalized);
  }

  private normalizeText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return "";
    const redacted = redactSensitive(trimmed);
    const limit = Math.min(this.maxChars, TELEGRAM_MAX_TEXT_CHARS);
    return truncateText(redacted, limit);
  }

  private async sendInitial(text: string): Promise<void> {
    try {
      const extra: Record<string, unknown> = {};
      if (this.parseMode) {
        extra.parse_mode = this.parseMode;
      }
      if (this.replyToMessageId) {
        try {
          extra.reply_parameters = {
            message_id: parseTelegramMessageId(this.replyToMessageId, "reply-to-channel-message-id"),
          };
        } catch (err) {
          if (isDaemonDebugEnabled()) {
            logEvent("warn", "telegram-status-message-reply-invalid", {
              "chat-id": this.chatId,
              error: errorMessage(err),
            });
          }
        }
      }

      let response: unknown;
      try {
        response = await this.telegram.sendMessage(this.chatId, text, extra as never);
      } catch (err) {
        if (extra.reply_parameters && isReplyToMessageNotFound(err)) {
          const fallback = { ...extra };
          delete fallback.reply_parameters;
          response = await this.telegram.sendMessage(this.chatId, text, fallback as never);
        } else {
          throw err;
        }
      }

      const messageId =
        response && typeof response === "object" && typeof (response as { message_id?: unknown }).message_id === "number"
          ? (response as { message_id: number }).message_id
          : undefined;
      if (!messageId) {
        throw new Error("missing message_id in Telegram response");
      }

      this.messageId = messageId;
      this.lastSentText = text;
      this.lastSentAtMs = Date.now();
    } catch (err) {
      this.disabled = true;
      if (isDaemonDebugEnabled()) {
        logEvent("warn", "telegram-status-message-start-failed", {
          "chat-id": this.chatId,
          error: errorMessage(err),
        });
      }
    }
  }

  private async sendUpdate(text: string): Promise<void> {
    if (this.sending) {
      this.pendingText = text;
      return;
    }
    if (!this.startPromise || this.disabled) return;

    this.sending = true;
    try {
      await this.startPromise;
      if (this.disabled || typeof this.messageId !== "number") return;

      await this.telegram.callApi("editMessageText", {
        chat_id: this.chatId,
        message_id: this.messageId,
        text,
        ...(this.parseMode ? { parse_mode: this.parseMode } : {}),
      });
      this.lastSentText = text;
      this.lastSentAtMs = Date.now();
    } catch (err) {
      if (isDaemonDebugEnabled()) {
        logEvent("warn", "telegram-status-message-update-failed", {
          "chat-id": this.chatId,
          "message-id": this.messageId,
          error: errorMessage(err),
        });
      }
    } finally {
      this.sending = false;
      const pending = this.pendingText;
      this.pendingText = null;
      if (pending && pending !== this.lastSentText && !this.finished) {
        this.update(pending);
      }
    }
  }
}
