import * as fs from "fs";
import * as path from "path";

import {
  SidecarHttpError,
  type IncomingWechatClawbotEvent,
  type WechatClawbotPendingOutboundMessage,
  type StoredWechatClawbotEvent,
  type StoredWechatClawbotSentMessage,
  type WechatClawbotPeerState,
  type WechatClawbotSidecarState,
} from "./types.js";

const CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

function emptyState(): WechatClawbotSidecarState {
  return {
    version: 1,
    next_seq: 1,
    events: [],
    peers: [],
    sent_messages: [],
    pending_outbox: [],
    seen_keys: [],
    account_cursors: {},
  };
}

function stringField(record: IncomingWechatClawbotEvent, ...keys: Array<keyof IncomingWechatClawbotEvent>): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function safeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

function dedupeKey(event: Pick<StoredWechatClawbotEvent, "account_id" | "peer_id" | "event_id" | "message_id">): string {
  const stableId = event.message_id ?? event.event_id;
  return `${event.account_id}:${event.peer_id}:${stableId}`;
}

function ensureStateShape(value: unknown): WechatClawbotSidecarState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState();
  const record = value as Partial<WechatClawbotSidecarState>;
  return {
    version: 1,
    next_seq: typeof record.next_seq === "number" && record.next_seq > 0 ? Math.trunc(record.next_seq) : 1,
    events: Array.isArray(record.events) ? record.events : [],
    peers: Array.isArray(record.peers) ? record.peers : [],
    sent_messages: Array.isArray(record.sent_messages) ? record.sent_messages : [],
    pending_outbox: Array.isArray(record.pending_outbox) ? record.pending_outbox : [],
    seen_keys: Array.isArray(record.seen_keys) ? record.seen_keys.filter((item) => typeof item === "string") : [],
    account_cursors:
      record.account_cursors && typeof record.account_cursors === "object" && !Array.isArray(record.account_cursors)
        ? record.account_cursors as Record<string, string>
        : {},
  };
}

export class WechatClawbotStateStore {
  private state: WechatClawbotSidecarState;

  constructor(private stateFile: string) {
    this.state = this.load();
    this.save();
  }

  listAccounts(): Array<{ account_id: string; peers: number }> {
    const accounts = new Map<string, number>();
    for (const peer of this.state.peers) {
      accounts.set(peer.account_id, (accounts.get(peer.account_id) ?? 0) + 1);
    }
    return Array.from(accounts.entries()).map(([account_id, peers]) => ({ account_id, peers }));
  }

  getUpdates(cursor?: string): { events: StoredWechatClawbotEvent[]; next_cursor: string } {
    const after = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
    const events = this.state.events
      .filter((event) => event.seq > after)
      .sort((left, right) => left.seq - right.seq)
      .slice(0, 100);
    const next = events.length > 0 ? events[events.length - 1].seq : after;
    return { events, next_cursor: String(next) };
  }

  getAccountCursor(accountId: string): string {
    return this.state.account_cursors[accountId] ?? "";
  }

  setAccountCursor(accountId: string, cursor: string): void {
    this.state.account_cursors[accountId] = cursor;
    this.save();
  }

  getPeerContextToken(accountId: string, peerId: string): string | undefined {
    return this.state.peers.find((peer) => peer.account_id === accountId && peer.peer_id === peerId)
      ?.context_token_ref;
  }

  ingestEvent(
    input: IncomingWechatClawbotEvent,
    fallbackAccount?: string
  ): { event: StoredWechatClawbotEvent; duplicate: boolean } {
    const accountId = stringField(input, "account_id", "accountId") ?? fallbackAccount;
    const peerId = stringField(input, "peer_id", "peerId");
    const text = stringField(input, "text");
    if (!accountId || !peerId || !text) {
      throw new SidecarHttpError(400, "invalid-event", "account_id, peer_id, and text are required");
    }

    const messageId = stringField(input, "message_id", "messageId");
    const eventId =
      stringField(input, "event_id", "eventId") ??
      `evt_${safeIdPart(accountId)}_${safeIdPart(peerId)}_${this.state.next_seq}`;
    const now = new Date().toISOString();
    const event: StoredWechatClawbotEvent = {
      seq: this.state.next_seq,
      event_id: eventId,
      account_id: accountId,
      peer_id: peerId,
      text,
      created_at: now,
      message_id: messageId,
      peer_name: stringField(input, "peer_name", "peerName"),
    };

    const key = dedupeKey(event);
    const existing = this.state.events.find((stored) => dedupeKey(stored) === key);
    if (existing || this.state.seen_keys.includes(key)) {
      return { event: existing ?? event, duplicate: true };
    }

    this.state.next_seq += 1;
    this.state.events.push(event);
    this.state.seen_keys.push(key);
    this.upsertPeer({
      account_id: accountId,
      peer_id: peerId,
      peer_name: event.peer_name,
      context_token_ref: stringField(input, "context_token_ref", "contextTokenRef") ?? `mock:${event.event_id}`,
      context_expires_at: new Date(new Date(now).getTime() + CONTEXT_WINDOW_MS).toISOString(),
      context_expiry_reminded_at: undefined,
      updated_at: now,
    });
    this.save();
    return { event, duplicate: false };
  }

  sendText(accountId: string, peerId: string, text: string): StoredWechatClawbotSentMessage {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new SidecarHttpError(400, "invalid-text", "text is required");
    }

    const peer = this.state.peers.find((item) => item.account_id === accountId && item.peer_id === peerId);
    if (!peer?.context_token_ref) {
      throw new SidecarHttpError(
        409,
        "missing-context-token",
        "peer has no active context token; have the peer send one test message first"
      );
    }

    const sent: StoredWechatClawbotSentMessage = {
      id: `sent_${Date.now()}_${this.state.sent_messages.length + 1}`,
      account_id: accountId,
      peer_id: peerId,
      text: trimmed,
      created_at: new Date().toISOString(),
    };
    this.state.sent_messages.push(sent);
    this.save();
    return sent;
  }

  recordSentText(accountId: string, peerId: string, text: string): StoredWechatClawbotSentMessage {
    const sent: StoredWechatClawbotSentMessage = {
      id: `sent_${Date.now()}_${this.state.sent_messages.length + 1}`,
      account_id: accountId,
      peer_id: peerId,
      text: text.trim(),
      created_at: new Date().toISOString(),
    };
    this.state.sent_messages.push(sent);
    this.save();
    return sent;
  }

  recordPendingOutbound(
    accountId: string,
    peerId: string,
    text: string,
    reason: string,
    error?: string
  ): WechatClawbotPendingOutboundMessage {
    const pending: WechatClawbotPendingOutboundMessage = {
      id: `pending_${Date.now()}_${this.state.pending_outbox.length + 1}`,
      account_id: accountId,
      peer_id: peerId,
      text: text.trim(),
      reason,
      created_at: new Date().toISOString(),
      attempts: 1,
      last_error: error,
    };
    this.state.pending_outbox.push(pending);
    this.save();
    return pending;
  }

  takePendingOutbound(accountId: string, peerId: string): WechatClawbotPendingOutboundMessage[] {
    const pending = this.state.pending_outbox.filter(
      (item) => item.account_id === accountId && item.peer_id === peerId
    );
    if (pending.length === 0) return [];
    this.state.pending_outbox = this.state.pending_outbox.filter(
      (item) => item.account_id !== accountId || item.peer_id !== peerId
    );
    this.save();
    return pending;
  }

  restorePendingOutbound(messages: WechatClawbotPendingOutboundMessage[], error?: string): void {
    if (messages.length === 0) return;
    const restored = messages.map((message) => ({
      ...message,
      attempts: message.attempts + 1,
      last_error: error ?? message.last_error,
    }));
    this.state.pending_outbox.unshift(...restored);
    this.save();
  }

  listPeersNeedingExpiryReminder(now = new Date()): WechatClawbotPeerState[] {
    const nowMs = now.getTime();
    const soonMs = nowMs + 60 * 60 * 1000;
    return this.state.peers.filter((peer) => {
      if (!peer.context_token_ref || !peer.context_expires_at || peer.context_expiry_reminded_at) return false;
      const expiresMs = Date.parse(peer.context_expires_at);
      return Number.isFinite(expiresMs) && expiresMs > nowMs && expiresMs <= soonMs;
    });
  }

  markExpiryReminderSent(accountId: string, peerId: string): void {
    const peer = this.state.peers.find((item) => item.account_id === accountId && item.peer_id === peerId);
    if (!peer) return;
    peer.context_expiry_reminded_at = new Date().toISOString();
    this.save();
  }

  private upsertPeer(peer: WechatClawbotPeerState): void {
    const index = this.state.peers.findIndex(
      (item) => item.account_id === peer.account_id && item.peer_id === peer.peer_id
    );
    if (index >= 0) {
      this.state.peers[index] = { ...this.state.peers[index], ...peer };
    } else {
      this.state.peers.push(peer);
    }
  }

  private load(): WechatClawbotSidecarState {
    if (!fs.existsSync(this.stateFile)) return emptyState();
    return ensureStateShape(JSON.parse(fs.readFileSync(this.stateFile, "utf8")));
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
    fs.chmodSync(this.stateFile, 0o600);
  }
}
