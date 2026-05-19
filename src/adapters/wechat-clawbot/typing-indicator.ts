import { errorMessage, isDaemonDebugEnabled, logEvent } from "../../shared/daemon-log.js";
import type { WechatClawbotSidecarClient, WechatClawbotTarget } from "./sidecar-client.js";

export interface WechatClawbotTypingIndicatorOptions {
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 5000;

export class WechatClawbotTypingIndicator {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private client: WechatClawbotSidecarClient,
    private target: WechatClawbotTarget,
    private options: WechatClawbotTypingIndicatorOptions = {}
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    void this.send(1);
    this.timer = setInterval(() => {
      void this.send(1);
    }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void this.send(2);
  }

  private async send(status: 1 | 2): Promise<void> {
    try {
      await this.client.sendTyping(this.target, status);
    } catch (err) {
      if (isDaemonDebugEnabled()) {
        logEvent("warn", "wechat-clawbot-typing-failed", {
          "account-id": this.target.accountId,
          "peer-id": this.target.peerId,
          status,
          error: errorMessage(err),
        });
      }
    }
  }
}
