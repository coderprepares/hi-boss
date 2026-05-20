import type {
  ChatAdapter,
  ChannelCommand,
  ChannelCommandHandler,
  ChannelMessageHandler,
  MessageContent,
  SendMessageOptions,
} from "./types.js";
import {
  buildWechatClawbotChannelMessage,
  parseWechatClawbotAdapterToken,
  parseWechatClawbotChatId,
  WECHAT_CLAWBOT_PLATFORM,
  WechatClawbotSidecarClient,
  type FetchLike,
  type WechatClawbotAdapterConfig,
  type WechatClawbotSidecarEvent,
} from "./wechat-clawbot/sidecar-client.js";
import { WechatClawbotTypingIndicator } from "./wechat-clawbot/typing-indicator.js";

export interface WechatClawbotAdapterOptions {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  cursorStore?: WechatClawbotCursorStore;
  skipExistingEventsOnEmptyCursor?: boolean;
}

export interface WechatClawbotCursorStore {
  load(): string | null | undefined;
  save(cursor: string): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSlashCommand(event: WechatClawbotSidecarEvent): ChannelCommand | undefined {
  const match = event.text?.match(/^\/(new|status|abort|help|getconfig)(?:\s+(.*))?$/i);
  if (!match) return undefined;

  return {
    platform: WECHAT_CLAWBOT_PLATFORM,
    command: match[1].toLowerCase(),
    args: match[2] ?? "",
    chatId: `${event.accountId}/${event.peerId}`,
    authorId: event.peerId,
  };
}

/**
 * WeChat ClawBot sidecar adapter.
 *
 * The adapter intentionally talks only to a local sidecar contract. It does
 * not load OpenClaw, iLink credentials, or real WeChat tokens into the daemon.
 */
export class WechatClawbotAdapter implements ChatAdapter {
  readonly platform = WECHAT_CLAWBOT_PLATFORM;

  private config: WechatClawbotAdapterConfig;
  private client: WechatClawbotSidecarClient;
  private handlers: ChannelMessageHandler[] = [];
  private commandHandlers: ChannelCommandHandler[] = [];
  private cursor: string | undefined;
  private cursorInitialized = false;
  private stopped = true;
  private started = false;
  private loop: Promise<void> | undefined;

  constructor(adapterToken: string, private options: WechatClawbotAdapterOptions = {}) {
    this.config = parseWechatClawbotAdapterToken(adapterToken);
    this.client = new WechatClawbotSidecarClient({
      config: this.config,
      fetchImpl: options.fetchImpl,
      env: options.env,
    });
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.handlers.push(handler);
  }

  onCommand(handler: ChannelCommandHandler): void {
    this.commandHandlers.push(handler);
  }

  async sendMessage(chatId: string, content: MessageContent, options: SendMessageOptions = {}): Promise<void> {
    const target = parseWechatClawbotChatId(chatId, this.config.defaultAccount);
    await this.client.sendText(target, content, options);
  }

  async handleCommand(command: ChannelCommand): Promise<MessageContent | void> {
    if (command.command !== "getconfig") return;
    if (command.args.trim()) {
      return { text: "error: usage /getconfig" };
    }

    const target = parseWechatClawbotChatId(command.chatId, this.config.defaultAccount);
    let result: Awaited<ReturnType<WechatClawbotSidecarClient["getConfig"]>>;
    try {
      result = await this.client.getConfig(target);
    } catch (err) {
      return { text: `error: ${err instanceof Error ? err.message : String(err)}` };
    }
    return {
      text: [
        "wechat-clawbot getconfig:",
        JSON.stringify(result.config, null, 2),
      ].join("\n"),
    };
  }

  createTypingIndicator(chatId: string): WechatClawbotTypingIndicator {
    const target = parseWechatClawbotChatId(chatId, this.config.defaultAccount);
    return new WechatClawbotTypingIndicator(this.client, target);
  }

  async pollOnce(): Promise<void> {
    const bootstrappedToTail = await this.initializeCursor();
    if (bootstrappedToTail) return;

    const result = await this.client.fetchUpdates(this.cursor);
    this.updateCursor(result.nextCursor);

    for (const event of result.events) {
      await this.dispatchEvent(event);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.loop = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (err) {
        console.error(`[${this.platform}] sidecar poll failed:`, err instanceof Error ? err.message : err);
      }

      if (!this.stopped) {
        await sleep(Math.max(250, this.config.pollIntervalMs));
      }
    }
  }

  private async initializeCursor(): Promise<boolean> {
    if (this.cursorInitialized) return false;
    this.cursorInitialized = true;

    const stored = this.options.cursorStore?.load()?.trim();
    if (stored) {
      this.cursor = stored;
      return false;
    }

    if (!this.options.skipExistingEventsOnEmptyCursor) {
      return false;
    }

    await this.advanceCursorToTail();
    return true;
  }

  private async advanceCursorToTail(): Promise<void> {
    for (let page = 0; page < 100; page += 1) {
      const result = await this.client.fetchUpdates(this.cursor);
      const previous = this.cursor;
      this.updateCursor(result.nextCursor);
      if (result.events.length === 0 || !result.nextCursor || result.nextCursor === previous) {
        return;
      }
    }
    throw new Error("wechat-clawbot cursor bootstrap exceeded 100 update pages");
  }

  private updateCursor(cursor: string | undefined): void {
    if (cursor === undefined) return;
    if (cursor === this.cursor) return;
    this.cursor = cursor;
    this.options.cursorStore?.save(cursor);
  }

  private async dispatchEvent(event: WechatClawbotSidecarEvent): Promise<void> {
    const command = parseSlashCommand(event);
    if (command && this.commandHandlers.length > 0) {
      for (const handler of this.commandHandlers) {
        const response = await handler(command);
        if (response?.text || response?.attachments?.length) {
          await this.sendMessage(command.chatId, response);
          return;
        }
      }
      return;
    }

    const message = buildWechatClawbotChannelMessage(event);
    for (const handler of this.handlers) {
      await handler(message);
    }
  }
}
