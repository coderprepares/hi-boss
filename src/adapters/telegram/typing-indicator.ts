import { errorMessage, isDaemonDebugEnabled, logEvent } from "../../shared/daemon-log.js";

type TelegramTypingApi = {
  callApi: (method: string, payload: unknown) => Promise<unknown>;
};

export interface TelegramTypingIndicatorOptions {
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 4000;

export class TelegramTypingIndicator {
  private telegram: TelegramTypingApi;
  private chatId: string;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(telegram: TelegramTypingApi, chatId: string, options: TelegramTypingIndicatorOptions = {}) {
    this.telegram = telegram;
    this.chatId = chatId;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.send();
    this.timer = setInterval(() => {
      void this.send();
    }, this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async send(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.telegram.callApi("sendChatAction", {
        chat_id: this.chatId,
        action: "typing",
      });
    } catch (err) {
      if (isDaemonDebugEnabled()) {
        logEvent("warn", "telegram-typing-failed", {
          "chat-id": this.chatId,
          error: errorMessage(err),
        });
      }
    }
  }
}
