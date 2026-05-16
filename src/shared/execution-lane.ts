import type { Agent } from "../agent/types.js";
import type { ChannelMessage } from "../adapters/types.js";

export interface ExecutionLaneRoute {
  adapterType?: string;
  chatId?: string;
  authorId?: string;
  accountId?: string;
  peerId?: string;
}

export interface ExecutionLaneConfig {
  id?: string;
  channelRoutes: ExecutionLaneRoute[];
  defaultLeader?: string;
  leaderPool: string[];
  backgroundMaxConcurrent?: number;
}

export interface ChannelRouteIdentity {
  adapterType: string;
  adapterToken: string;
  chatId: string;
  authorId?: string;
  accountId?: string;
  peerId?: string;
}

export interface ExecutionLaneResolution {
  agentName: string;
  lane?: ExecutionLaneConfig;
  matchedRoute?: ExecutionLaneRoute;
  source: "channel-route" | "binding";
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n > 0 ? n : undefined;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function parseRoute(value: unknown): ExecutionLaneRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const route: ExecutionLaneRoute = {};
  const adapterType = stringField(record, "adapterType");
  const chatId = stringField(record, "chatId");
  const authorId = stringField(record, "authorId");
  const accountId = stringField(record, "accountId");
  const peerId = stringField(record, "peerId");
  if (adapterType !== undefined) route.adapterType = adapterType;
  if (chatId !== undefined) route.chatId = chatId;
  if (authorId !== undefined) route.authorId = authorId;
  if (accountId !== undefined) route.accountId = accountId;
  if (peerId !== undefined) route.peerId = peerId;
  return Object.values(route).some((field) => field !== undefined) ? route : undefined;
}

export function parseExecutionLaneConfig(metadata: Record<string, unknown> | undefined): ExecutionLaneConfig | undefined {
  const raw = metadata?.executionLane;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const channelRoutes = Array.isArray(record.channelRoutes)
    ? record.channelRoutes.map(parseRoute).filter((route): route is ExecutionLaneRoute => route !== undefined)
    : [];
  const leaderPool = parseStringArray(record.leaderPool);
  const defaultLeader = stringField(record, "defaultLeader");
  return {
    id: stringField(record, "id"),
    channelRoutes,
    defaultLeader,
    leaderPool: defaultLeader && !leaderPool.includes(defaultLeader)
      ? [defaultLeader, ...leaderPool]
      : leaderPool,
    backgroundMaxConcurrent: parsePositiveInt(record.backgroundMaxConcurrent),
  };
}

export function getExecutionLanePromptContext(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const lane = parseExecutionLaneConfig(metadata);
  return {
    id: lane?.id ?? "",
    defaultLeader: lane?.defaultLeader ?? "",
    leaderPool: lane?.leaderPool ?? [],
    backgroundMaxConcurrent: lane?.backgroundMaxConcurrent ?? 0,
    channelRoutes: lane?.channelRoutes ?? [],
  };
}

export function buildChannelRouteIdentity(params: {
  adapterType: string;
  adapterToken: string;
  message: ChannelMessage;
}): ChannelRouteIdentity {
  return buildChannelRouteIdentityFromParts({
    adapterType: params.adapterType,
    adapterToken: params.adapterToken,
    chatId: params.message.chat.id,
    authorId: params.message.author.id,
  });
}

export function buildChannelRouteIdentityFromParts(params: {
  adapterType: string;
  adapterToken: string;
  chatId: string;
  authorId?: string;
}): ChannelRouteIdentity {
  const [accountId, peerId] =
    params.adapterType === "wechat-clawbot" && params.chatId.includes("/")
      ? params.chatId.split("/", 2)
      : [undefined, undefined];
  return {
    adapterType: params.adapterType,
    adapterToken: params.adapterToken,
    chatId: params.chatId,
    authorId: params.authorId,
    accountId,
    peerId,
  };
}

function routeScore(route: ExecutionLaneRoute, identity: ChannelRouteIdentity): number {
  let score = 0;
  if (route.adapterType !== undefined) {
    if (route.adapterType !== identity.adapterType) return -1;
    score += 1;
  }
  if (route.chatId !== undefined) {
    if (route.chatId !== identity.chatId) return -1;
    score += 20;
  }
  if (route.authorId !== undefined) {
    if (route.authorId !== identity.authorId) return -1;
    score += 30;
  }
  if (route.accountId !== undefined) {
    if (route.accountId !== identity.accountId) return -1;
    score += 15;
  }
  if (route.peerId !== undefined) {
    if (route.peerId !== identity.peerId && route.peerId !== identity.authorId) return -1;
    score += 30;
  }
  return score;
}

export function resolveExecutionLaneForChannel(params: {
  agents: Agent[];
  fallbackAgentName: string;
  identity: ChannelRouteIdentity;
}): ExecutionLaneResolution {
  let best:
    | { agentName: string; lane: ExecutionLaneConfig; route: ExecutionLaneRoute; score: number }
    | undefined;

  for (const agent of params.agents) {
    const lane = parseExecutionLaneConfig(agent.metadata);
    if (!lane) continue;
    for (const route of lane.channelRoutes) {
      const score = routeScore(route, params.identity);
      if (score < 0) continue;
      if (!best || score > best.score) {
        best = { agentName: agent.name, lane, route, score };
      }
    }
  }

  if (best) {
    return {
      agentName: best.agentName,
      lane: best.lane,
      matchedRoute: best.route,
      source: "channel-route",
    };
  }

  return {
    agentName: params.fallbackAgentName,
    source: "binding",
  };
}
