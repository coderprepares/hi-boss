import * as fs from "fs";
import * as path from "path";
import type { Agent } from "../agent/types.js";
import type { AgentBinding } from "../daemon/db/database.js";
import type { Envelope, EnvelopeAttachment } from "../envelope/types.js";
import { detectAttachmentType } from "../adapters/types.js";
import { formatUnixMsAsTimeZoneOffset } from "./time.js";
import { getDaemonIanaTimeZone } from "./timezone.js";
import { HIBOSS_TOKEN_ENV } from "./env.js";
import { getAgentDir, getHiBossDir } from "../agent/home-setup.js";
import {
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_MEMORY_LONGTERM_MAX_CHARS,
  DEFAULT_MEMORY_SHORTTERM_DAYS,
  DEFAULT_MEMORY_SHORTTERM_PER_DAY_MAX_CHARS,
  getDefaultRuntimeWorkspace,
} from "./defaults.js";
import { formatShortId } from "./id-format.js";
import { parseAgentRoleFromMetadata } from "./agent-role.js";
import { getExecutionLanePromptContext } from "./execution-lane.js";
import {
  buildInReplyTo,
  buildSemanticFrom,
  isChannelMetadata,
  withBossMarkerSuffix,
} from "./channel-prompt-context.js";

const MAX_CUSTOM_FILE_CHARS = 10_000;

export interface HiBossCustomizationFiles {
  boss?: string;
}

export interface AgentCustomizationFiles {
  soul?: string;
}

function truncateFileContents(contents: string): string {
  if (contents.length <= MAX_CUSTOM_FILE_CHARS) return contents;
  return (
    contents.slice(0, MAX_CUSTOM_FILE_CHARS) +
    "\n\n[...truncated...]\n"
  );
}

function readOptionalFile(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
    const contents = fs.readFileSync(filePath, "utf-8");
    return truncateFileContents(contents);
  } catch {
    return undefined;
  }
}

export function readHiBossCustomizationFiles(hibossDir: string): HiBossCustomizationFiles {
  const boss = readOptionalFile(path.join(hibossDir, "BOSS.md"));
  return { boss };
}

export function readAgentCustomizationFiles(params: {
  hibossDir: string;
  agentName: string;
}): AgentCustomizationFiles {
  const agentDir = getAgentDir(params.agentName, params.hibossDir);
  const soul = readOptionalFile(path.join(agentDir, "SOUL.md"));
  return { soul };
}

function displayAttachmentName(att: { source: string; filename?: string }): string | undefined {
  if (att.filename) return att.filename;

  try {
    const url = new URL(att.source);
    const base = path.posix.basename(url.pathname);
    return base || undefined;
  } catch {
    // Not a URL; treat as local path
  }

  return path.basename(att.source) || undefined;
}

function formatAttachmentsText(attachments: EnvelopeAttachment[] | undefined): string {
  if (!attachments?.length) return "(none)";

  return attachments
    .map((att) => {
      const type = detectAttachmentType(att);
      const displayName = displayAttachmentName(att);
      if (!displayName || displayName === att.source) {
        return `- [${type}] ${att.source}`;
      }
      return `- [${type}] ${displayName} (${att.source})`;
    })
    .join("\n");
}

function getCronScheduleId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>).cronScheduleId;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function buildSystemPromptContext(params: {
  agent: Agent;
  agentToken: string;
  bindings: AgentBinding[];
  time?: {
    bossTimezone?: string;
  };
  hibossDir?: string;
  boss?: {
    name?: string;
    adapterIds?: Record<string, string>;
  };
}): Record<string, unknown> {
  const hibossDir = params.hibossDir ?? getHiBossDir();
  const bossTimeZone = (params.time?.bossTimezone ?? "").trim() || getDaemonIanaTimeZone();
  const daemonTimeZone = getDaemonIanaTimeZone();

  const workspaceDir =
    params.agent.workspace && params.agent.workspace.trim()
      ? params.agent.workspace.trim()
      : getDefaultRuntimeWorkspace();

  const hibossFiles = readHiBossCustomizationFiles(hibossDir);
  const agentFiles = readAgentCustomizationFiles({ hibossDir, agentName: params.agent.name });

  const agentRole = parseAgentRoleFromMetadata(params.agent.metadata);
  if (!agentRole) {
    throw new Error(
      `Agent '${params.agent.name}' is missing required metadata.role (speaker|leader). ` +
        "Run `hiboss agent set --name <agent> --role <speaker|leader>`."
    );
  }

  return {
    environment: {
      time: formatUnixMsAsTimeZoneOffset(Date.now(), bossTimeZone),
      bossTimezone: bossTimeZone,
      daemonTimezone: daemonTimeZone,
    },
    hiboss: {
      dir: hibossDir,
      tokenEnvVar: HIBOSS_TOKEN_ENV,
      additionalContext: "",
      files: {
        boss: hibossFiles.boss ?? "",
      },
    },
    internalSpace: {
      note: "",
      noteFence: "```",
      daily: "",
      dailyFence: "```",
      error: "",
      dailyError: "",
      longtermMaxChars: DEFAULT_MEMORY_LONGTERM_MAX_CHARS,
      dailyRecentFiles: DEFAULT_MEMORY_SHORTTERM_DAYS,
      dailyPerFileMaxChars: DEFAULT_MEMORY_SHORTTERM_PER_DAY_MAX_CHARS,
      dailyMaxChars: DEFAULT_MEMORY_SHORTTERM_PER_DAY_MAX_CHARS * DEFAULT_MEMORY_SHORTTERM_DAYS,
    },
    boss: {
      name: params.boss?.name ?? "",
      adapterIds: params.boss?.adapterIds ?? {},
    },
    agent: {
      name: params.agent.name,
      role: agentRole,
      description: params.agent.description ?? "",
      workspace: workspaceDir,
      provider: params.agent.provider ?? DEFAULT_AGENT_PROVIDER,
      model: params.agent.model ?? "",
      reasoningEffort: params.agent.reasoningEffort ?? "",
      permissionLevel: params.agent.permissionLevel ?? "",
      sessionPolicy: {
        dailyResetAt: params.agent.sessionPolicy?.dailyResetAt ?? "",
        idleTimeout: params.agent.sessionPolicy?.idleTimeout ?? "",
        maxContextLength: params.agent.sessionPolicy?.maxContextLength ?? 0,
      },
      createdAt: formatUnixMsAsTimeZoneOffset(params.agent.createdAt, bossTimeZone),
      lastSeenAt:
        typeof params.agent.lastSeenAt === "number"
          ? formatUnixMsAsTimeZoneOffset(params.agent.lastSeenAt, bossTimeZone)
          : "",
      metadata: params.agent.metadata ?? {},
      executionLane: getExecutionLanePromptContext(params.agent.metadata),
      files: {
        soul: agentFiles.soul ?? "",
      },
    },
    auth: {
      agentToken: params.agentToken,
    },
    bindings: (params.bindings ?? []).map((b) => ({
      adapterType: b.adapterType,
      createdAt: formatUnixMsAsTimeZoneOffset(b.createdAt, bossTimeZone),
    })),
    workspace: {
      dir: workspaceDir,
    },
  };
}

export function buildTurnPromptContext(params: {
  agentName: string;
  datetimeMs: number;
  bossTimezone: string;
  envelopes: Envelope[];
}): Record<string, unknown> {
  const bossTimeZone = params.bossTimezone.trim() || getDaemonIanaTimeZone();
  const envelopes = (params.envelopes ?? []).map((env, idx) => {
    const semantic = buildSemanticFrom(env);
    const inReplyTo = buildInReplyTo(env.metadata);
    const attachments = (env.content.attachments ?? []).map((att) => {
      const type = detectAttachmentType(att);
      const displayName = displayAttachmentName(att) ?? "";
      return {
        type,
        source: att.source,
        filename: att.filename ?? "",
        displayName,
      };
    });

    const authorLine = semantic ? withBossMarkerSuffix(semantic.authorName, env.fromBoss) : "";
    const senderLine = (() => {
      if (!semantic) return "";
      if (!isChannelMetadata(env.metadata)) return "";
      if (semantic.isGroup) return `${authorLine} in group "${semantic.groupName}"`;
      return `${authorLine} in private chat`;
    })();

    const cronId = (() => {
      const cronScheduleId = getCronScheduleId(env.metadata);
      return cronScheduleId ? formatShortId(cronScheduleId) : "";
    })();

    const deliverAtPresent = typeof env.deliverAt === "number";
    const deliverAt = deliverAtPresent
      ? {
          present: true,
          iso: formatUnixMsAsTimeZoneOffset(env.deliverAt as number, bossTimeZone),
        }
      : { present: false, iso: "" };

    return {
      index: idx + 1,
      id: env.id,
      idShort: formatShortId(env.id),
      from: env.from,
      fromName: semantic?.fromName ?? "",
      fromBoss: env.fromBoss,
      isGroup: semantic?.isGroup ?? false,
      groupName: semantic?.groupName ?? "",
      authorName: semantic?.authorName ?? "",
      authorLine,
      senderLine,
      inReplyTo,
      createdAt: {
        iso: formatUnixMsAsTimeZoneOffset(env.createdAt, bossTimeZone),
      },
      deliverAt,
      cronId,
      content: {
        text: env.content.text ?? "(none)",
        attachments,
        attachmentsText: formatAttachmentsText(env.content.attachments),
      },
    };
  });

  let envelopeBlockCount = 0;
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i];
    const prev = i > 0 ? envelopes[i - 1] : undefined;
    const isGroupContinuation =
      i > 0 &&
      env.isGroup &&
      prev?.isGroup &&
      prev.from === env.from;
    if (!isGroupContinuation) {
      envelopeBlockCount++;
    }
  }

  return {
    turn: {
      datetimeIso: formatUnixMsAsTimeZoneOffset(params.datetimeMs, bossTimeZone),
      agentName: params.agentName,
      envelopeCount: envelopes.length,
      envelopeBlockCount,
    },
    envelopes,
  };
}

export function buildCliEnvelopePromptContext(params: {
  envelope: Envelope;
  bossTimezone: string;
}): Record<string, unknown> {
  const env = params.envelope;
  const bossTimeZone = params.bossTimezone.trim() || getDaemonIanaTimeZone();
  const semantic = buildSemanticFrom(env);
  const inReplyTo = buildInReplyTo(env.metadata);
  const attachments = (env.content.attachments ?? []).map((att) => {
    const type = detectAttachmentType(att);
    const displayName = displayAttachmentName(att) ?? "";
    return {
      type,
      source: att.source,
      filename: att.filename ?? "",
      displayName,
    };
  });

  const deliverAtPresent = typeof env.deliverAt === "number";
  const deliverAt = deliverAtPresent
    ? {
        present: true,
        iso: formatUnixMsAsTimeZoneOffset(env.deliverAt as number, bossTimeZone),
      }
    : { present: false, iso: "" };

  const authorLine = semantic ? withBossMarkerSuffix(semantic.authorName, env.fromBoss) : "";
  const senderLine = (() => {
    if (!semantic) return "";
    if (!isChannelMetadata(env.metadata)) return "";
    if (semantic.isGroup) return `${authorLine} in group "${semantic.groupName}"`;
    return `${authorLine} in private chat`;
  })();

  const cronId = (() => {
    const cronScheduleId = getCronScheduleId(env.metadata);
    return cronScheduleId ? formatShortId(cronScheduleId) : "";
  })();

  const lastDeliveryError = (() => {
    if (!env.metadata || typeof env.metadata !== "object") return null;
    const raw = (env.metadata as Record<string, unknown>).lastDeliveryError;
    if (!raw || typeof raw !== "object") return null;

    const r = raw as Record<string, unknown>;
    const atMs = r.atMs;
    if (typeof atMs !== "number") return null;

    return {
      ...r,
      at: formatUnixMsAsTimeZoneOffset(atMs, bossTimeZone),
    };
  })();

  return {
    envelope: {
      id: env.id,
      idShort: formatShortId(env.id),
      from: env.from,
      to: env.to,
      status: env.status,
      fromName: semantic?.fromName ?? "",
      fromBoss: env.fromBoss,
      isGroup: semantic?.isGroup ?? false,
      groupName: semantic?.groupName ?? "",
      authorName: semantic?.authorName ?? "",
      authorLine,
      senderLine,
      inReplyTo,
      createdAt: {
        iso: formatUnixMsAsTimeZoneOffset(env.createdAt, bossTimeZone),
      },
      deliverAt,
      cronId,
      content: {
        text: env.content.text ?? "(none)",
        attachments,
        attachmentsText: formatAttachmentsText(env.content.attachments),
      },
      lastDeliveryError,
      metadata: env.metadata ?? {},
    },
  };
}
