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

const DEFAULT_MIN_INTERVAL_MS = 2000;
const DEFAULT_MAX_CHARS = 800;

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
  private replaced = false;
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
    if (this.replaced) return;
    if (this.disabled) return;
    const normalized = this.normalizeText(text);
    if (!normalized) return;

    if (!this.startPromise) {
      this.startPromise = this.sendInitial(normalized);
      this.finished = true;
      return;
    }

    this.finished = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.pendingText = null;

    void this.sendUpdate(normalized);
  }

  replace(text: string, options: { parseMode?: "MarkdownV2" | "HTML" } = {}): boolean {
    if (this.disabled) return false;
    const normalized = this.normalizeReplacementText(text);
    if (!normalized) return false;

    this.replaced = true;
    this.finished = true;
    if (!this.startPromise) {
      this.startPromise = this.sendInitial(normalized);
      return true;
    }
    void this.sendUpdate(normalized, options);
    return true;
  }

  async delete(): Promise<void> {
    if (this.disabled) return;
    this.disabled = true;
    this.finished = true;
    this.replaced = true;

    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.pendingText = null;

    if (!this.startPromise) return;

    try {
      await this.startPromise;
    } catch {
      return;
    }

    if (typeof this.messageId !== "number") return;

    try {
      await this.telegram.callApi("deleteMessage", {
        chat_id: this.chatId,
        message_id: this.messageId,
      });
      if (isDaemonDebugEnabled()) {
        logEvent("info", "telegram-status-message-delete", {
          "chat-id": this.chatId,
          "message-id": this.messageId,
        });
      }
    } catch (err) {
      if (isDaemonDebugEnabled()) {
        logEvent("warn", "telegram-status-message-delete-failed", {
          "chat-id": this.chatId,
          "message-id": this.messageId,
          error: errorMessage(err),
        });
      }
    }
  }

  private normalizeText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return "";
    const redacted = redactSensitive(trimmed);
    const limit = Math.min(this.maxChars, TELEGRAM_MAX_TEXT_CHARS);
    return truncateText(redacted, limit);
  }

  private normalizeReplacementText(text: string): string {
    if (!text || !text.trim()) return "";
    if (text.length > TELEGRAM_MAX_TEXT_CHARS) return "";
    return text;
  }

  private async ensureReady(): Promise<boolean> {
    if (this.disabled || !this.startPromise) return false;
    await this.startPromise;
    return !this.disabled && typeof this.messageId === "number";
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
      if (isDaemonDebugEnabled()) {
        logEvent("info", "telegram-status-message-start", {
          "chat-id": this.chatId,
          "message-id": messageId,
        });
      }
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

  private async sendUpdate(text: string, options: { parseMode?: "MarkdownV2" | "HTML" } = {}): Promise<void> {
    if (this.sending) {
      this.pendingText = text;
      return;
    }

    this.sending = true;
    try {
      if (!(await this.ensureReady())) return;
      if (this.disabled || typeof this.messageId !== "number") return;
      if (text === this.lastSentText) return;

      const parseMode = options.parseMode ?? this.parseMode;
      await this.telegram.callApi("editMessageText", {
        chat_id: this.chatId,
        message_id: this.messageId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      this.lastSentText = text;
      this.lastSentAtMs = Date.now();
      if (isDaemonDebugEnabled()) {
        logEvent("info", "telegram-status-message-update", {
          "chat-id": this.chatId,
          "message-id": this.messageId,
        });
      }
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
      if (this.pendingText) {
        const pending = this.pendingText;
        this.pendingText = null;
        const elapsed = Date.now() - this.lastSentAtMs;
        if (elapsed >= this.minIntervalMs) {
          void this.sendUpdate(pending);
        } else if (!this.pendingTimer) {
          const delay = Math.max(this.minIntervalMs - elapsed, 0);
          this.pendingTimer = setTimeout(() => {
            this.pendingTimer = null;
            void this.sendUpdate(pending);
          }, delay);
        }
      }
    }
  }
}
