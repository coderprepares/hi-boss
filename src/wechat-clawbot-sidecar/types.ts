export interface WechatClawbotSidecarConfig {
  host: string;
  port: number;
  stateFile: string;
  mediaDir: string;
  transport: "mock" | "ilink";
  apiTokenEnv?: string;
  apiTokenFile?: string;
  mockIngestEnabled: boolean;
  allowNonLocalBind: boolean;
  defaultAccount?: string;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  ilinkApiBaseUrl: string;
  ilinkCdnBaseUrl: string;
  ilinkAccounts: WechatClawbotIlinkAccountConfig[];
}

export interface WechatClawbotIlinkAccountConfig {
  accountId: string;
  botTokenEnv?: string;
  botTokenFile?: string;
  xWechatUin?: string;
}

export interface WechatClawbotSidecarRuntimeOptions {
  apiToken?: string;
  ilinkFetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export interface StoredWechatClawbotEvent {
  seq: number;
  event_id: string;
  account_id: string;
  peer_id: string;
  text?: string;
  attachments?: StoredWechatClawbotAttachment[];
  created_at: string;
  message_id?: string;
  peer_name?: string;
}

export interface StoredWechatClawbotAttachment {
  source: string;
  filename?: string;
}

export interface WechatClawbotPeerState {
  account_id: string;
  peer_id: string;
  updated_at: string;
  peer_name?: string;
  context_token_ref?: string;
  context_expires_at?: string;
  context_expiry_reminded_at?: string;
}

export interface StoredWechatClawbotSentMessage {
  id: string;
  account_id: string;
  peer_id: string;
  text: string;
  created_at: string;
}

export interface WechatClawbotPendingOutboundMessage {
  id: string;
  account_id: string;
  peer_id: string;
  text: string;
  reason: string;
  created_at: string;
  attempts: number;
  last_error?: string;
}

export interface WechatClawbotSidecarState {
  version: 1;
  next_seq: number;
  events: StoredWechatClawbotEvent[];
  peers: WechatClawbotPeerState[];
  sent_messages: StoredWechatClawbotSentMessage[];
  pending_outbox: WechatClawbotPendingOutboundMessage[];
  seen_keys: string[];
  account_cursors: Record<string, string>;
}

export interface WechatClawbotSidecarStateStatus {
  accounts: number;
  peers: number;
  events: number;
  next_cursor: string;
  sent_messages: number;
  pending_outbox: number;
  pending_outbox_reasons: Record<string, number>;
  context_active: number;
  context_expiring_soon: number;
  context_expired: number;
  next_context_expires_at?: string;
  last_event?: {
    seq: number;
    created_at: string;
  };
  last_sent?: {
    created_at: string;
  };
}

export interface IncomingWechatClawbotEvent {
  account_id?: string;
  accountId?: string;
  peer_id?: string;
  peerId?: string;
  text?: string;
  attachments?: StoredWechatClawbotAttachment[];
  event_id?: string;
  eventId?: string;
  message_id?: string;
  messageId?: string;
  peer_name?: string;
  peerName?: string;
  context_token_ref?: string;
  contextTokenRef?: string;
}

export interface IlinkMessage {
  messageId: string;
  fromUserId: string;
  text?: string;
  attachments?: StoredWechatClawbotAttachment[];
  contextToken: string;
  createTimeMs?: number;
}

export class SidecarHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
