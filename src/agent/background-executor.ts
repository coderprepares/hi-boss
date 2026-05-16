import type { HiBossDatabase } from "../daemon/db/database.js";
import type { MessageRouter } from "../daemon/router/message-router.js";
import type { Envelope } from "../envelope/types.js";
import { detectAttachmentType, formatAgentAddress, parseAddress } from "../adapters/types.js";
import {
  BACKGROUND_AGENT_NAME,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_BACKGROUND_MAX_CONCURRENT,
  getDefaultRuntimeWorkspace,
} from "../shared/defaults.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import { executeBackgroundPrompt } from "./background-turn.js";
import { parseExecutionLaneConfig } from "../shared/execution-lane.js";

export interface BackgroundSenderAgentSnapshot {
  state: "idle" | "active";
  queuedCount: number;
  runningCount: number;
  openCount: number;
}

export type BackgroundPromptRunner = typeof executeBackgroundPrompt;

type BackgroundQueueItem = {
  envelope: Envelope;
  senderAgentKey: string | null;
};

function formatAttachmentsForPrompt(envelope: Envelope): string {
  const attachments = envelope.content.attachments ?? [];
  if (attachments.length === 0) return "(none)";

  return attachments
    .map((att) => {
      const type = detectAttachmentType(att);
      return `- [${type}] ${att.filename ? `${att.filename} (${att.source})` : att.source}`;
    })
    .join("\n");
}

function buildBackgroundPrompt(envelope: Envelope): string {
  const text = envelope.content.text?.trim() ? envelope.content.text.trim() : "(none)";
  const attachmentsText = formatAttachmentsForPrompt(envelope);

  if (attachmentsText === "(none)") {
    return text;
  }

  return [text, "", "attachments:", attachmentsText].join("\n");
}

export class BackgroundExecutor {
  private readonly maxConcurrent: number;
  private readonly queue: BackgroundQueueItem[] = [];
  private readonly senderCounts = new Map<string, { queuedCount: number; runningCount: number }>();
  private readonly runPrompt: BackgroundPromptRunner;
  private inFlight = 0;

  constructor(
    private readonly deps: { db: HiBossDatabase; router: MessageRouter },
    options: { maxConcurrent?: number; runPrompt?: BackgroundPromptRunner } = {}
  ) {
    const raw = options.maxConcurrent ?? DEFAULT_BACKGROUND_MAX_CONCURRENT;
    const n = Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_BACKGROUND_MAX_CONCURRENT;
    this.maxConcurrent = Math.max(1, Math.min(32, n));
    this.runPrompt = options.runPrompt ?? executeBackgroundPrompt;
  }

  getSenderAgentSnapshot(agentName: string): BackgroundSenderAgentSnapshot {
    const key = agentName.trim().toLowerCase();
    const counts = this.senderCounts.get(key) ?? { queuedCount: 0, runningCount: 0 };
    const openCount = counts.queuedCount + counts.runningCount;
    return {
      state: openCount > 0 ? "active" : "idle",
      queuedCount: counts.queuedCount,
      runningCount: counts.runningCount,
      openCount,
    };
  }

  private resolveSenderAgentKey(envelope: Envelope): string | null {
    try {
      const from = parseAddress(envelope.from);
      if (from.type !== "agent") return null;
      const normalized = from.agentName.trim().toLowerCase();
      return normalized || null;
    } catch {
      return null;
    }
  }

  private updateSenderCounts(
    senderAgentKey: string,
    delta: { queuedCount?: number; runningCount?: number }
  ): void {
    const current = this.senderCounts.get(senderAgentKey) ?? { queuedCount: 0, runningCount: 0 };
    const next = {
      queuedCount: Math.max(0, current.queuedCount + (delta.queuedCount ?? 0)),
      runningCount: Math.max(0, current.runningCount + (delta.runningCount ?? 0)),
    };
    if (next.queuedCount === 0 && next.runningCount === 0) {
      this.senderCounts.delete(senderAgentKey);
      return;
    }
    this.senderCounts.set(senderAgentKey, next);
  }

  private getSenderRunningLimit(senderAgentKey: string | null): number {
    if (!senderAgentKey) return this.maxConcurrent;
    const agent = this.deps.db.getAgentByNameCaseInsensitive(senderAgentKey);
    const laneLimit = parseExecutionLaneConfig(agent?.metadata)?.backgroundMaxConcurrent;
    return laneLimit ? Math.min(this.maxConcurrent, laneLimit) : this.maxConcurrent;
  }

  private canStartItem(item: BackgroundQueueItem): boolean {
    if (!item.senderAgentKey) return true;
    const counts = this.senderCounts.get(item.senderAgentKey) ?? { queuedCount: 0, runningCount: 0 };
    return counts.runningCount < this.getSenderRunningLimit(item.senderAgentKey);
  }

  /**
   * Enqueue a background envelope for execution (best-effort, non-blocking).
   *
   * The envelope is ACKed immediately (marked `done`) to preserve at-most-once semantics.
   */
  enqueue(envelope: Envelope): void {
    try {
      this.deps.db.updateEnvelopeStatus(envelope.id, "done");
    } catch (err) {
      logEvent("error", "background-envelope-ack-failed", {
        "envelope-id": envelope.id,
        error: errorMessage(err),
      });
      // Continue anyway; best-effort.
    }

    const senderAgentKey = this.resolveSenderAgentKey(envelope);
    if (senderAgentKey) {
      this.updateSenderCounts(senderAgentKey, { queuedCount: 1 });
    }

    this.queue.push({ envelope, senderAgentKey });
    this.drain();
  }

  private drain(): void {
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const index = this.queue.findIndex((candidate) => this.canStartItem(candidate));
      if (index < 0) return;
      const [item] = this.queue.splice(index, 1);
      if (item.senderAgentKey) {
        this.updateSenderCounts(item.senderAgentKey, { queuedCount: -1, runningCount: 1 });
      }
      this.inFlight++;
      void this.runOne(item.envelope)
        .catch((err) => {
          logEvent("error", "background-job-failed", {
            "envelope-id": item.envelope.id,
            error: errorMessage(err),
          });
        })
        .finally(() => {
          if (item.senderAgentKey) {
            this.updateSenderCounts(item.senderAgentKey, { runningCount: -1 });
          }
          this.inFlight--;
          this.drain();
        });
    }
  }

  private resolveWorkspace(envelope: Envelope, senderWorkspace: string): string {
    const md = envelope.metadata;
    if (!md || typeof md !== "object") return senderWorkspace;
    const v = (md as Record<string, unknown>).workspace;
    if (typeof v !== "string") return senderWorkspace;
    const trimmed = v.trim();
    return trimmed || senderWorkspace;
  }

  private async runOne(envelope: Envelope): Promise<void> {
    const startedAtMs = Date.now();

    let senderName: string;
    try {
      const from = parseAddress(envelope.from);
      if (from.type !== "agent") {
        throw new Error("from is not an agent");
      }
      senderName = from.agentName;
    } catch {
      logEvent("warn", "background-invalid-sender", { "envelope-id": envelope.id, from: envelope.from });
      return;
    }

    const senderAgent = this.deps.db.getAgentByNameCaseInsensitive(senderName);
    if (!senderAgent) {
      logEvent("warn", "background-sender-agent-not-found", { "envelope-id": envelope.id, "agent-name": senderName });
      return;
    }

    const provider = senderAgent.provider ?? DEFAULT_AGENT_PROVIDER;
    const workspace = this.resolveWorkspace(
      envelope,
      senderAgent.workspace?.trim() || getDefaultRuntimeWorkspace()
    );
    const prompt = buildBackgroundPrompt(envelope);

    logEvent("info", "background-job-start", {
      "envelope-id": envelope.id,
      from: envelope.from,
      to: envelope.to,
      provider,
      workspace,
    });

    let finalText: string;
    try {
      const result = await this.runPrompt({
        provider,
        workspace,
        prompt,
        model: senderAgent.model,
        reasoningEffort: senderAgent.reasoningEffort ?? undefined,
      });
      finalText = result.finalText?.trim() ? result.finalText.trim() : "(no response)";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finalText = `Background job failed: ${msg}`;
    }

    // Feedback envelope: send back to the sender; reply-to the background request envelope.
    await this.deps.router.routeEnvelope({
      from: formatAgentAddress(BACKGROUND_AGENT_NAME),
      to: formatAgentAddress(senderAgent.name),
      fromBoss: false,
      content: { text: finalText },
      metadata: {
        replyToEnvelopeId: envelope.id,
      },
    });

    logEvent("info", "background-job-complete", {
      "envelope-id": envelope.id,
      from: envelope.from,
      to: envelope.to,
      state: "success",
      "duration-ms": Date.now() - startedAtMs,
    });
  }
}

export function createBackgroundExecutor(params: {
  db: HiBossDatabase;
  router: MessageRouter;
  maxConcurrent?: number;
}): BackgroundExecutor {
  return new BackgroundExecutor({ db: params.db, router: params.router }, { maxConcurrent: params.maxConcurrent });
}
