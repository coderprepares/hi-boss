export interface WechatClawbotSidecarConfig {
  host: string;
  port: number;
  stateFile: string;
  apiTokenEnv?: string;
  apiTokenFile?: string;
  mockIngestEnabled: boolean;
  allowNonLocalBind: boolean;
  defaultAccount?: string;
}

export interface WechatClawbotSidecarRuntimeOptions {
  apiToken?: string;
}

export interface StoredWechatClawbotEvent {
  seq: number;
  event_id: string;
  account_id: string;
  peer_id: string;
  text: string;
  created_at: string;
  message_id?: string;
  peer_name?: string;
}

export interface WechatClawbotPeerState {
  account_id: string;
  peer_id: string;
  updated_at: string;
  peer_name?: string;
  context_token_ref?: string;
}

export interface StoredWechatClawbotSentMessage {
  id: string;
  account_id: string;
  peer_id: string;
  text: string;
  created_at: string;
}

export interface WechatClawbotSidecarState {
  version: 1;
  next_seq: number;
  events: StoredWechatClawbotEvent[];
  peers: WechatClawbotPeerState[];
  sent_messages: StoredWechatClawbotSentMessage[];
  seen_keys: string[];
}

export interface IncomingWechatClawbotEvent {
  account_id?: string;
  accountId?: string;
  peer_id?: string;
  peerId?: string;
  text?: string;
  event_id?: string;
  eventId?: string;
  message_id?: string;
  messageId?: string;
  peer_name?: string;
  peerName?: string;
  context_token_ref?: string;
  contextTokenRef?: string;
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
