import * as http from "http";
import { timingSafeEqual } from "crypto";

import { WechatClawbotIlinkClient } from "./ilink-client.js";
import { WechatClawbotStateStore } from "./state.js";
import {
  SidecarHttpError,
  type IncomingWechatClawbotEvent,
  type StoredWechatClawbotAttachment,
  type WechatClawbotIlinkAccountConfig,
  type WechatClawbotSidecarConfig,
  type WechatClawbotSidecarRuntimeOptions,
} from "./types.js";

const MAX_BODY_BYTES = 64 * 1024;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function equalToken(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new SidecarHttpError(413, "body-too-large", "request body too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SidecarHttpError(400, "invalid-json", "JSON object body is required");
  }
  return parsed as Record<string, unknown>;
}

function requireAuth(req: http.IncomingMessage, apiToken?: string): void {
  if (!apiToken) return;
  const header = req.headers.authorization ?? "";
  const expected = "Bearer ";
  if (!header.startsWith(expected) || !equalToken(header.slice(expected.length), apiToken)) {
    throw new SidecarHttpError(401, "unauthorized", "missing or invalid bearer token");
  }
}

function decodeParts(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function routeSendMessage(parts: string[]): { accountId: string; peerId: string } | undefined {
  if (parts.length !== 5) return undefined;
  if (parts[0] !== "accounts" || parts[2] !== "peers" || parts[4] !== "messages") return undefined;
  return { accountId: parts[1], peerId: parts[3] };
}

function routePeerAction(parts: string[], action: string): { accountId: string; peerId: string } | undefined {
  if (parts.length !== 5) return undefined;
  if (parts[0] !== "accounts" || parts[2] !== "peers" || parts[4] !== action) return undefined;
  return { accountId: parts[1], peerId: parts[3] };
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeStatusError(err: unknown): string {
  return errorMessage(err)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(bot[_-]?token[\"']?\s*[:=]\s*[\"']?)[^\"'\s,}]+/gi, "$1[redacted]")
    .slice(0, 500);
}

function normalizeBodyAttachments(body: Record<string, unknown>): StoredWechatClawbotAttachment[] {
  const raw = Array.isArray(body.attachments) ? body.attachments : [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const source = typeof record.source === "string" ? record.source.trim() : "";
    if (!source) return [];
    const filename = typeof record.filename === "string" && record.filename.trim()
      ? record.filename.trim()
      : undefined;
    return [{ source, filename }];
  });
}

function contentSummary(text: string, attachments: StoredWechatClawbotAttachment[]): string {
  const trimmed = text.trim();
  if (trimmed && attachments.length > 0) return `${trimmed}\n[attachments: ${attachments.length}]`;
  if (trimmed) return trimmed;
  return `[attachments: ${attachments.length}]`;
}

export class WechatClawbotSidecarServer {
  private server: http.Server;
  private store: WechatClawbotStateStore;
  private ilink?: WechatClawbotIlinkClient;
  private pollTimer?: NodeJS.Timeout;
  private stopped = true;
  private startedAt = new Date().toISOString();
  private lastPollStartedAt?: string;
  private currentPollStartedMs?: number;
  private lastPollCompletedAt?: string;
  private lastPollDurationMs?: number;
  private lastPollErrorAt?: string;
  private lastPollError?: string;
  private pollInFlight = false;
  private pollConsecutiveFailures = 0;
  private typingTickets = new Map<string, { ticket: string; updatedAtMs: number }>();

  constructor(
    private config: WechatClawbotSidecarConfig,
    private runtime: WechatClawbotSidecarRuntimeOptions = {}
  ) {
    this.store = new WechatClawbotStateStore(config.stateFile);
    if (config.transport === "ilink") {
      this.ilink = new WechatClawbotIlinkClient({
        apiBaseUrl: config.ilinkApiBaseUrl,
        cdnBaseUrl: config.ilinkCdnBaseUrl,
        mediaDir: config.mediaDir,
        requestTimeoutMs: config.requestTimeoutMs,
        fetchImpl: runtime.ilinkFetchImpl,
      });
    }
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => this.handleError(res, err));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off("error", reject);
        this.stopped = false;
        this.startPolling();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  url(): string {
    const address = this.server.address();
    if (typeof address === "object" && address) {
      return `http://${address.address}:${address.port}`;
    }
    return `http://${this.config.host}:${this.config.port}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const parts = decodeParts(url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      json(res, 200, {
        ok: true,
        service: "wechat-clawbot-sidecar",
        transport: this.config.transport,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      json(res, 200, {
        ok: true,
        service: "wechat-clawbot-sidecar",
        transport: this.config.transport,
        started_at: this.startedAt,
        poll_interval_ms: this.config.pollIntervalMs,
        request_timeout_ms: this.config.requestTimeoutMs,
        state: this.store.getStatusSnapshot(),
        ilink_poll: {
          enabled: Boolean(this.ilink),
          in_flight: this.pollInFlight,
          current_duration_ms: this.pollInFlight && this.currentPollStartedMs !== undefined
            ? Math.max(0, Date.now() - this.currentPollStartedMs)
            : undefined,
          last_started_at: this.lastPollStartedAt,
          last_completed_at: this.lastPollCompletedAt,
          last_duration_ms: this.lastPollDurationMs,
          last_error_at: this.lastPollErrorAt,
          last_error: this.lastPollError,
          consecutive_failures: this.pollConsecutiveFailures,
        },
      });
      return;
    }

    requireAuth(req, this.runtime.apiToken);

    if (req.method === "GET" && url.pathname === "/accounts") {
      json(res, 200, { accounts: this.store.listAccounts() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/updates") {
      json(res, 200, this.store.getUpdates(url.searchParams.get("cursor") ?? undefined));
      return;
    }

    if (req.method === "POST" && url.pathname === "/__mock/events") {
      if (!this.config.mockIngestEnabled) {
        throw new SidecarHttpError(404, "not-found", "not found");
      }
      const body = await readJsonBody(req);
      const result = this.store.ingestEvent(body as IncomingWechatClawbotEvent, this.config.defaultAccount);
      json(res, result.duplicate ? 200 : 201, result);
      return;
    }

    const sendTarget = routeSendMessage(parts);
    if (req.method === "POST" && sendTarget) {
      const body = await readJsonBody(req);
      const text = typeof body.text === "string" ? body.text : "";
      const attachments = normalizeBodyAttachments(body);
      const sent = await this.sendMessage(sendTarget.accountId, sendTarget.peerId, { text, attachments });
      json(res, 200, { ok: true, message_id: sent.id });
      return;
    }

    const configTarget = routePeerAction(parts, "config");
    if (req.method === "GET" && configTarget) {
      const result = await this.getConfig(configTarget.accountId, configTarget.peerId);
      json(res, 200, {
        ok: true,
        account_id: configTarget.accountId,
        peer_id: configTarget.peerId,
        config: result.config,
      });
      return;
    }

    const typingTarget = routePeerAction(parts, "typing");
    if (req.method === "POST" && typingTarget) {
      const body = await readJsonBody(req);
      const status = body.status === 2 ? 2 : 1;
      await this.sendTyping(typingTarget.accountId, typingTarget.peerId, status);
      json(res, 200, { ok: true });
      return;
    }

    throw new SidecarHttpError(404, "not-found", "not found");
  }

  private handleError(res: http.ServerResponse, err: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof SidecarHttpError) {
      json(res, err.status, { ok: false, error: err.code, message: err.message });
      return;
    }
    json(res, 500, { ok: false, error: "internal-error", message: "internal sidecar error" });
  }

  private startPolling(): void {
    if (!this.ilink || this.stopped) return;
    this.pollTimer = setTimeout(async () => {
      const startedMs = Date.now();
      this.pollInFlight = true;
      this.currentPollStartedMs = startedMs;
      this.lastPollStartedAt = new Date(startedMs).toISOString();
      try {
        await this.pollIlinkOnce();
        this.lastPollDurationMs = Date.now() - startedMs;
        this.lastPollCompletedAt = new Date().toISOString();
        this.lastPollError = undefined;
        this.pollConsecutiveFailures = 0;
      } catch (err) {
        this.lastPollDurationMs = Date.now() - startedMs;
        this.lastPollErrorAt = new Date().toISOString();
        this.lastPollError = safeStatusError(err);
        this.pollConsecutiveFailures += 1;
      } finally {
        this.pollInFlight = false;
      }
      this.startPolling();
    }, this.config.pollIntervalMs);
  }

  private async pollIlinkOnce(): Promise<void> {
    if (!this.ilink) return;
    for (const account of this.config.ilinkAccounts) {
      const cursor = this.store.getAccountCursor(account.accountId);
      const updates = await this.ilink.fetchUpdates(account, cursor);
      for (const message of updates.messages) {
        this.store.ingestEvent({
          account_id: account.accountId,
          peer_id: message.fromUserId,
          message_id: message.messageId,
          event_id: `${account.accountId}:${message.messageId}`,
          text: message.text,
          attachments: message.attachments,
          context_token_ref: message.contextToken,
        });
        await this.flushPendingOutbound(account, message.fromUserId).catch(() => undefined);
      }
      this.store.setAccountCursor(account.accountId, updates.nextCursor);
    }
    await this.sendExpiryReminders().catch(() => undefined);
  }

  private async sendMessage(
    accountId: string,
    peerId: string,
    content: { text: string; attachments: StoredWechatClawbotAttachment[] }
  ) {
    const trimmed = content.text.trim();
    const attachments = content.attachments;
    if (!trimmed && attachments.length === 0) {
      throw new SidecarHttpError(400, "invalid-content", "text or attachments are required");
    }
    if (!this.ilink) {
      if (!this.store.getPeerContextToken(accountId, peerId)) {
        throw new SidecarHttpError(
          409,
          "missing-context-token",
          "peer has no active context token; have the peer send one test message first"
        );
      }
      return this.store.recordSentText(accountId, peerId, contentSummary(trimmed, attachments));
    }
    const account = this.config.ilinkAccounts.find((item) => item.accountId === accountId);
    if (!account) throw new SidecarHttpError(404, "account-not-found", "iLink account not found");
    const contextToken = this.store.getPeerContextToken(accountId, peerId);
    if (!contextToken) {
      throw new SidecarHttpError(
        409,
        "missing-context-token",
        "peer has no active context token; have the peer send one test message first"
      );
    }
    try {
      await this.ilink.sendMessage(account, peerId, contextToken, { text: trimmed, attachments });
    } catch (err) {
      if (attachments.length === 0) {
        this.store.recordPendingOutbound(accountId, peerId, trimmed, "send-failed", errorMessage(err));
      }
      throw new SidecarHttpError(
        502,
        attachments.length === 0 ? "send-failed-queued" : "send-failed",
        attachments.length === 0 ? "send failed; message queued for next peer activation" : "send failed"
      );
    }
    return this.store.recordSentText(accountId, peerId, contentSummary(trimmed, attachments));
  }

  private accountById(accountId: string): WechatClawbotIlinkAccountConfig {
    const account = this.config.ilinkAccounts.find((item) => item.accountId === accountId);
    if (!account) throw new SidecarHttpError(404, "account-not-found", "iLink account not found");
    return account;
  }

  private getRequiredContextToken(accountId: string, peerId: string): string {
    const contextToken = this.store.getPeerContextToken(accountId, peerId);
    if (!contextToken) {
      throw new SidecarHttpError(
        409,
        "missing-context-token",
        "peer has no active context token; have the peer send one test message first"
      );
    }
    return contextToken;
  }

  private async getConfig(
    accountId: string,
    peerId: string
  ): Promise<{ config: unknown; typingTicket?: string }> {
    if (!this.ilink) {
      throw new SidecarHttpError(501, "unsupported-transport", "getconfig requires ilink transport");
    }
    const account = this.accountById(accountId);
    const contextToken = this.getRequiredContextToken(accountId, peerId);
    const config = await this.ilink.getConfig(account, peerId, contextToken);
    const record = config && typeof config === "object" && !Array.isArray(config)
      ? config as Record<string, unknown>
      : {};
    const typingTicket = stringField(record, "typing_ticket", "typingTicket");
    if (typingTicket) {
      this.typingTickets.set(`${accountId}/${peerId}`, { ticket: typingTicket, updatedAtMs: Date.now() });
    }
    return { config, typingTicket };
  }

  private async sendTyping(accountId: string, peerId: string, status: 1 | 2): Promise<void> {
    if (!this.ilink) {
      throw new SidecarHttpError(501, "unsupported-transport", "typing requires ilink transport");
    }
    const account = this.accountById(accountId);
    const cacheKey = `${accountId}/${peerId}`;
    let ticket = this.typingTickets.get(cacheKey)?.ticket;
    if (!ticket) {
      const result = await this.getConfig(accountId, peerId);
      ticket = result.typingTicket;
    }
    if (!ticket) {
      throw new SidecarHttpError(502, "typing-ticket-missing", "iLink getconfig response missing typing_ticket");
    }
    await this.ilink.sendTyping(account, peerId, ticket, status);
  }

  private async flushPendingOutbound(account: WechatClawbotIlinkAccountConfig, peerId: string): Promise<void> {
    if (!this.ilink) return;
    const pending = this.store.takePendingOutbound(account.accountId, peerId);
    if (pending.length === 0) return;
    const contextToken = this.store.getPeerContextToken(account.accountId, peerId);
    if (!contextToken) {
      this.store.restorePendingOutbound(pending, "missing context token during flush");
      return;
    }
    const text = pending.length === 1
      ? pending[0].text
      : [
          `你离线期间有 ${pending.length} 条待发送消息：`,
          ...pending.map((message, index) => `${index + 1}. ${message.text}`),
        ].join("\n");
    try {
      await this.ilink.sendText(account, peerId, contextToken, text);
      this.store.recordSentText(account.accountId, peerId, text);
    } catch (err) {
      this.store.restorePendingOutbound(pending, errorMessage(err));
    }
  }

  private async sendExpiryReminders(): Promise<void> {
    if (!this.ilink) return;
    for (const peer of this.store.listPeersNeedingExpiryReminder()) {
      const account = this.config.ilinkAccounts.find((item) => item.accountId === peer.account_id);
      if (!account || !peer.context_token_ref) continue;
      const text = "微信 ClawBot 回复窗口快过期了。如需继续接收后续消息，请回复任意一句话来续期。";
      try {
        await this.ilink.sendText(account, peer.peer_id, peer.context_token_ref, text);
        this.store.recordSentText(peer.account_id, peer.peer_id, text);
        this.store.markExpiryReminderSent(peer.account_id, peer.peer_id);
      } catch {
        this.store.markExpiryReminderSent(peer.account_id, peer.peer_id);
      }
    }
  }
}
