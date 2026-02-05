/**
 * Agent executor for running agent sessions with the unified agent SDK.
 */
import type { RunHandle } from "@unified-agent-sdk/runtime";
import type { Agent } from "./types.js";
import type { HiBossDatabase } from "../daemon/db/database.js";
import { getHiBossDir } from "./home-setup.js";
import { buildTurnInput } from "./turn-input.js";
import {
  parseDurationToMs,
  parseSessionPolicyConfig,
} from "../shared/session-policy.js";
import {
  DEFAULT_AGENT_AUTO_LEVEL,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_RUN_TIMEOUT,
} from "../shared/defaults.js";
import { errorMessage, isDaemonDebugEnabled, logEvent } from "../shared/daemon-log.js";
import {
  queueAgentTask,
  type AgentSession,
  type SessionRefreshRequest,
} from "./executor-support.js";
import { writePersistedAgentSession } from "./persisted-session.js";
import type { AgentRunTrigger } from "./executor-triggers.js";
import { getTriggerFields } from "./executor-triggers.js";
import { countDuePendingEnvelopesForAgent } from "./executor-db.js";
import { getOrCreateAgentSession } from "./executor-session.js";
import type { Envelope } from "../envelope/types.js";
import { AgentRunTimeoutError, executeUnifiedTurn, type RuntimeEvent } from "./executor-turn.js";

/**
 * Maximum number of pending envelopes to process in a single turn.
 */
const MAX_ENVELOPES_PER_TURN = 10;
const AGENT_RUN_WAIT_LOG_INTERVAL_MS = 30000;

export type AgentRunStatusReporter = {
  onEvent?: (event: RuntimeEvent) => void;
  finish?: (result: { status: "success" | "error" | "cancelled" | "timeout"; error?: string }) => void | Promise<void>;
};

export type AgentRunStatusReporterFactory = (params: {
  agent: Agent;
  envelopes: Envelope[];
  db: HiBossDatabase;
  runId: string;
  trigger?: AgentRunTrigger;
}) => AgentRunStatusReporter | undefined;

type InFlightAgentRun = {
  runRecordId: string;
  abortController: AbortController;
  runHandle: RunHandle | null;
  abortReason?: string;
};

/**
 * Agent executor manages agent sessions and runs.
 */
export class AgentExecutor {
  private sessions: Map<string, AgentSession> = new Map();
  private agentLocks: Map<string, Promise<void>> = new Map();
  private inFlightRuns: Map<string, InFlightAgentRun> = new Map();
  private pendingSessionRefresh: Map<string, SessionRefreshRequest> = new Map();
  private db: HiBossDatabase | null;
  private hibossDir: string;
  private onEnvelopesDone?: (envelopeIds: string[], db: HiBossDatabase) => void | Promise<void>;
  private createRunStatusReporter?: AgentRunStatusReporterFactory;

  constructor(
    options: {
      db?: HiBossDatabase;
      hibossDir?: string;
      onEnvelopesDone?: (envelopeIds: string[], db: HiBossDatabase) => void | Promise<void>;
      createRunStatusReporter?: AgentRunStatusReporterFactory;
    } = {}
  ) {
    this.db = options.db ?? null;
    this.hibossDir = options.hibossDir ?? getHiBossDir();
    this.onEnvelopesDone = options.onEnvelopesDone;
    this.createRunStatusReporter = options.createRunStatusReporter;
  }

  /**
   * True if the daemon currently has a queued or in-flight task for this agent.
   *
   * This is a busy-ness signal (used for operator UX); it is not persisted.
   */
  isAgentBusy(agentName: string): boolean {
    return this.agentLocks.has(agentName);
  }

  /**
   * Cancel the current in-flight run for an agent (best-effort).
   *
   * Note: this does not clear pending envelopes. Callers should clear the inbox
   * separately (e.g., via an operator abort RPC).
   */
  abortCurrentRun(agentName: string, reason: string): boolean {
    const inFlight = this.inFlightRuns.get(agentName);
    if (!inFlight) return false;

    if (!inFlight.abortReason) {
      inFlight.abortReason = reason;
    }

    inFlight.abortController.abort();

    if (inFlight.runHandle) {
      inFlight.runHandle.cancel().catch((err) => {
        logEvent("warn", "agent-run-cancel-failed", {
          "agent-name": agentName,
          error: errorMessage(err),
        });
      });
    }

    return true;
  }

  /**
   * Request a session refresh for an agent.
   *
   * Safe to call at any time (including during a run). The refresh will be applied
   * at the next safe point (before the next run, or after the current queue drains).
   *
   * Non-blocking: callers should not await this for interactive UX (e.g., Telegram /new).
   */
  requestSessionRefresh(agentName: string, reason: string): void {
    const existing = this.pendingSessionRefresh.get(agentName);
    if (existing) {
      existing.reasons.push(reason);
    } else {
      this.pendingSessionRefresh.set(agentName, {
        requestedAtMs: Date.now(),
        reasons: [reason],
      });
    }

    // Ensure the pending refresh gets applied even if no additional turns run.
    queueAgentTask({
      agentLocks: this.agentLocks,
      agentName,
      log: () => undefined,
      task: async () => {
        await this.applyPendingSessionRefresh(agentName);
      },
    }).catch((err) => {
      logEvent("error", "agent-session-remove-queue-failed", {
        "agent-name": agentName,
        error: errorMessage(err),
      });
    });
  }

  private getSessionPolicy(agent: Agent) {
    return parseSessionPolicyConfig(agent.sessionPolicy, { strict: false });
  }

  private getAndClearPendingRefreshReasons(agentName: string): string[] {
    const pending = this.pendingSessionRefresh.get(agentName);
    if (!pending) return [];
    this.pendingSessionRefresh.delete(agentName);
    return pending.reasons;
  }

  private async applyPendingSessionRefresh(agentName: string): Promise<string[]> {
    const reasons = this.getAndClearPendingRefreshReasons(agentName);
    if (reasons.length === 0) return [];
    await this.refreshSession(agentName, reasons.join(","));
    return reasons;
  }

  /**
   * Check and run agent if pending envelopes exist.
   *
   * Non-blocking with queue-safe atomic locks per agent.
   * If an agent is already running, waits for completion then runs.
   */
  async checkAndRun(agent: Agent, db: HiBossDatabase, trigger?: AgentRunTrigger): Promise<void> {
    const agentName = agent.name;

    await queueAgentTask({
      agentLocks: this.agentLocks,
      agentName,
      log: () => undefined,
      task: async () => {
        const acknowledged = await this.runAgent(agent, db, trigger);

        // Self-reschedule if more pending work exists
        if (acknowledged > 0) {
          const pending = db.getPendingEnvelopesForAgent(agent.name, 1);
          if (pending.length > 0) {
            setImmediate(() => {
              this.checkAndRun(agent, db, { kind: "reschedule" }).catch((err) => {
                logEvent("error", "agent-check-and-run-failed", {
                  "agent-name": agent.name,
                  ...getTriggerFields({ kind: "reschedule" }),
                  error: errorMessage(err),
                });
              });
            });
          }
        }
      },
    });
  }

  /**
   * Run the agent with pending envelopes.
   */
  private async runAgent(agent: Agent, db: HiBossDatabase, trigger?: AgentRunTrigger): Promise<number> {
    // Get pending envelopes
    const envelopes = db.getPendingEnvelopesForAgent(
      agent.name,
      MAX_ENVELOPES_PER_TURN
    );

    if (envelopes.length === 0) {
      return 0;
    }

    // Mark envelopes done immediately after read (at-most-once).
    const envelopeIds = envelopes.map((e) => e.id);
    db.markEnvelopesDone(envelopeIds);

    if (this.onEnvelopesDone) {
      try {
        await this.onEnvelopesDone(envelopeIds, db);
      } catch (err) {
        logEvent("error", "agent-on-envelopes-done-failed", {
          "agent-name": agent.name,
          error: errorMessage(err),
        });
      }
    }

    const pendingRemainingCount = countDuePendingEnvelopesForAgent(db, agent.name);

    // Create run record for auditing
    const run = db.createAgentRun(agent.name, envelopeIds);
    const triggerFields = getTriggerFields(trigger);
    let runStartedAtMs: number | null = null;
    const reporter = this.createRunStatusReporter
      ? this.createRunStatusReporter({ agent, envelopes, db, runId: run.id, trigger })
      : undefined;
    const debugEvents = isDaemonDebugEnabled();
    const runTimeoutValue = agent.runTimeout ?? DEFAULT_AGENT_RUN_TIMEOUT;
    const timeoutMs = this.resolveRunTimeoutMs(agent);
    const shouldLogWait = debugEvents;
    let lastEventAtMs = Date.now();
    let lastEventType = "run.start";
    let pendingTool: { name?: string; callId?: string; startedAtMs: number } | null = null;
    let waitTimer: NodeJS.Timeout | null = null;

    const startWaitLogger = (): void => {
      if (!shouldLogWait || waitTimer) return;
      waitTimer = setInterval(() => {
        const idleMs = Date.now() - lastEventAtMs;
        if (idleMs < AGENT_RUN_WAIT_LOG_INTERVAL_MS) return;
        const reason = pendingTool ? "tool" : "provider";
        logEvent("info", "agent-run-waiting", {
          "agent-name": agent.name,
          "agent-run-id": run.id,
          reason,
          "idle-ms": idleMs,
          "last-event-type": lastEventType,
          ...(pendingTool?.name ? { "tool-name": pendingTool.name } : {}),
          ...(pendingTool?.callId ? { "tool-call-id": pendingTool.callId } : {}),
          ...(pendingTool ? { "tool-idle-ms": Date.now() - pendingTool.startedAtMs } : {}),
        });
      }, AGENT_RUN_WAIT_LOG_INTERVAL_MS);
    };

    const stopWaitLogger = (): void => {
      if (!waitTimer) return;
      clearInterval(waitTimer);
      waitTimer = null;
    };

    const handleEvent =
      debugEvents || reporter?.onEvent
        ? (event: RuntimeEvent) => {
            const eventType = typeof event.type === "string" ? event.type : "unknown";
            lastEventAtMs = Date.now();
            lastEventType = eventType;
            if (eventType === "tool.call") {
              const toolName =
                typeof (event as { toolName?: unknown }).toolName === "string"
                  ? String((event as { toolName?: unknown }).toolName)
                  : undefined;
              const callId =
                typeof (event as { callId?: unknown }).callId === "string"
                  ? String((event as { callId?: unknown }).callId)
                  : undefined;
              pendingTool = {
                name: toolName,
                callId,
                startedAtMs: Date.now(),
              };
            } else if (eventType === "tool.result" || eventType === "tool.error") {
              const callId =
                typeof (event as { callId?: unknown }).callId === "string"
                  ? String((event as { callId?: unknown }).callId)
                  : undefined;
              if (!pendingTool || !pendingTool.callId || !callId || pendingTool.callId === callId) {
                pendingTool = null;
              }
            } else if (eventType.startsWith("assistant.") || eventType === "run.completed") {
              pendingTool = null;
            }
            if (debugEvents) {
              const toolName =
                eventType === "tool.call" && typeof (event as { toolName?: unknown }).toolName === "string"
                  ? String((event as { toolName?: unknown }).toolName)
                  : undefined;
              const toolCallId =
                (eventType === "tool.call" || eventType === "tool.result" || eventType === "tool.error") &&
                typeof (event as { callId?: unknown }).callId === "string"
                  ? String((event as { callId?: unknown }).callId)
                  : undefined;
              logEvent("info", "agent-run-event", {
                "agent-name": agent.name,
                "agent-run-id": run.id,
                "event-type": eventType,
                ...(toolName ? { "tool-name": toolName } : {}),
                ...(toolCallId ? { "tool-call-id": toolCallId } : {}),
              });
            }
            return reporter?.onEvent?.(event);
          }
        : undefined;

    const finishReporter = async (
      status: "success" | "error" | "cancelled" | "timeout",
      error?: string
    ): Promise<void> => {
      if (!reporter?.finish) return;
      try {
        await reporter.finish({ status, error });
      } catch (err) {
        logEvent("warn", "agent-run-status-finish-failed", {
          "agent-name": agent.name,
          "agent-run-id": run.id,
          error: errorMessage(err),
        });
      }
    };

    const inFlight: InFlightAgentRun = {
      runRecordId: run.id,
      abortController: new AbortController(),
      runHandle: null,
    };
    this.inFlightRuns.set(agent.name, inFlight);

    try {
      if (inFlight.abortController.signal.aborted) {
        const reason = inFlight.abortReason ?? "abort-requested";
        db.cancelAgentRun(run.id, reason);
        logEvent("info", "agent-run-complete", {
          "agent-name": agent.name,
          "agent-run-id": run.id,
          state: "cancelled",
          "duration-ms": 0,
          "context-length": null,
          reason,
        });
        return envelopeIds.length;
      }

      // Get or create session
      const session = await this.getOrCreateSession(agent, db, trigger);

      // Build turn input
      const turnInput = buildTurnInput({
        context: {
          datetimeMs: Date.now(),
          agentName: agent.name,
          bossTimezone: db.getBossTimezone(),
        },
        envelopes,
      });

      logEvent("info", "agent-run-start", {
        "agent-name": agent.name,
        "agent-run-id": run.id,
        "envelopes-read-count": envelopeIds.length,
        "pending-remaining-count": pendingRemainingCount,
        "run-timeout": runTimeoutValue,
        ...triggerFields,
      });
      runStartedAtMs = Date.now();
      lastEventAtMs = runStartedAtMs;
      lastEventType = "run.start";
      startWaitLogger();

      // Execute the turn
      let turn;
      try {
        turn = await executeUnifiedTurn(session, turnInput, {
          signal: inFlight.abortController.signal,
          onRunHandle: (handle) => {
            inFlight.runHandle = handle;
          },
          onEvent: handleEvent,
          timeoutMs,
        });
      } finally {
        stopWaitLogger();
      }

      if (turn.status === "cancelled") {
        const reason = inFlight.abortReason ?? "run-cancelled";
        db.cancelAgentRun(run.id, reason);
        logEvent("info", "agent-run-complete", {
          "agent-name": agent.name,
          "agent-run-id": run.id,
          state: "cancelled",
          "duration-ms": runStartedAtMs ? Date.now() - runStartedAtMs : 0,
          "context-length": null,
          reason,
        });
        return envelopeIds.length;
      }

      const response = turn.finalText;
      session.lastRunCompletedAtMs = Date.now();

      // Persist session handle for best-effort resume after daemon restart.
      try {
        const handle = await session.session.snapshot();
        if (handle.sessionId) {
          writePersistedAgentSession(db, agent.name, {
            version: 1,
            provider: session.provider,
            handle,
            createdAtMs: session.createdAtMs,
            lastRunCompletedAtMs: session.lastRunCompletedAtMs,
            updatedAtMs: Date.now(),
          });
        }
      } catch (err) {
        logEvent("warn", "agent-session-snapshot-failed", {
          "agent-name": agent.name,
          error: errorMessage(err),
        });
      }

      // Complete the run record
      db.completeAgentRun(run.id, response, turn.usage.contextLength);

      logEvent("info", "agent-run-complete", {
        "agent-name": agent.name,
        "agent-run-id": run.id,
        state: "success",
        "duration-ms": runStartedAtMs ? Date.now() - runStartedAtMs : 0,
        "context-length": turn.usage.contextLength,
        "input-tokens": turn.usage.inputTokens,
        "output-tokens": turn.usage.outputTokens,
        "cache-read-tokens": turn.usage.cacheReadTokens,
        "cache-write-tokens": turn.usage.cacheWriteTokens,
        "total-tokens": turn.usage.totalTokens,
      });

      // Context-length refresh: if a run grew the context too large, reset the session for the next run.
      const policy = this.getSessionPolicy(agent);
      if (
        typeof policy.maxContextLength === "number" &&
        turn.usage.contextLength !== null &&
        turn.usage.contextLength > policy.maxContextLength
      ) {
        await this.refreshSession(
          agent.name,
          `max-context-length:${turn.usage.contextLength}>${policy.maxContextLength}`
        );
      }
      void finishReporter("success");
      return envelopeIds.length;
    } catch (error) {
      stopWaitLogger();
      const errorMessage = error instanceof Error ? error.message : String(error);
      db.failAgentRun(run.id, errorMessage);
      const isTimeout = error instanceof AgentRunTimeoutError;
      if (isTimeout) {
        logEvent("info", "agent-run-timeout", {
          "agent-name": agent.name,
          "agent-run-id": run.id,
          "run-timeout-ms": timeoutMs,
        });
      }
      logEvent("info", "agent-run-complete", {
        "agent-name": agent.name,
        "agent-run-id": run.id,
        state: "failed",
        "duration-ms": runStartedAtMs ? Date.now() - runStartedAtMs : 0,
        "context-length": null,
        error: errorMessage,
      });
      void finishReporter(isTimeout ? "timeout" : "error", errorMessage);
      throw error;
    } finally {
      const existing = this.inFlightRuns.get(agent.name);
      if (existing && existing.runRecordId === run.id) {
        this.inFlightRuns.delete(agent.name);
      }
    }
  }

  /**
   * Get or create a session for an agent.
   */
  private async getOrCreateSession(
    agent: Agent,
    db: HiBossDatabase,
    trigger?: AgentRunTrigger
  ): Promise<AgentSession> {
    return await getOrCreateAgentSession({
      agent,
      db,
      hibossDir: this.hibossDir,
      sessions: this.sessions,
      applyPendingSessionRefresh: (name) => this.applyPendingSessionRefresh(name),
      refreshSession: (name, reason) => this.refreshSession(name, reason),
      getSessionPolicy: (a) => this.getSessionPolicy(a),
      mapAccessLevel: (level) => this.mapAccessLevel(level),
      trigger,
    });
  }

  /**
   * Map auto level to SDK access level.
   */
  private resolveRunTimeoutMs(agent: Agent): number {
    const raw = agent.runTimeout ?? DEFAULT_AGENT_RUN_TIMEOUT;
    try {
      return parseDurationToMs(raw);
    } catch (err) {
      logEvent("warn", "agent-run-timeout-invalid", {
        "agent-name": agent.name,
        "run-timeout": raw,
        error: errorMessage(err),
      });
      return parseDurationToMs(DEFAULT_AGENT_RUN_TIMEOUT);
    }
  }

  private mapAccessLevel(autoLevel: "medium" | "high"): "medium" | "high" {
    // Direct mapping - SDK uses same values
    return autoLevel;
  }

  /**
   * Refresh session for an agent (called by /new command).
   *
   * Clears the existing session so a new one will be created on next run.
   */
  async refreshSession(agentName: string, reason?: string): Promise<void> {
    // If a refresh is requested (or just happened), clear any pending flags to avoid duplicate refreshes.
    this.pendingSessionRefresh.delete(agentName);

    if (this.db) {
      try {
        writePersistedAgentSession(this.db, agentName, null);
      } catch (err) {
        logEvent("warn", "agent-session-handle-clear-failed", {
          "agent-name": agentName,
          reason,
          error: errorMessage(err),
        });
      }
    }

    const session = this.sessions.get(agentName);
    if (session) {
      // Dispose session and close runtime
      await session.session.dispose();
      await session.runtime.close();
      this.sessions.delete(agentName);
    }

    logEvent("info", "agent-session-remove", {
      "agent-name": agentName,
      reason,
      state: "success",
    });
  }

  /**
   * Close all sessions on shutdown.
   */
  async closeAll(): Promise<void> {
    for (const [agentName, session] of this.sessions) {
      await session.session.dispose();
      await session.runtime.close();
    }
    this.sessions.clear();
    this.agentLocks.clear();
  }
}

export function createAgentExecutor(options?: {
  db?: HiBossDatabase;
  hibossDir?: string;
  onEnvelopesDone?: (envelopeIds: string[], db: HiBossDatabase) => void | Promise<void>;
  createRunStatusReporter?: AgentRunStatusReporterFactory;
}): AgentExecutor {
  return new AgentExecutor(options);
}
