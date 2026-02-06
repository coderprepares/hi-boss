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
  type TurnTokenUsage,
} from "./executor-support.js";
import { writePersistedAgentSession } from "./persisted-session.js";
import type { AgentRunTrigger } from "./executor-triggers.js";
import { getTriggerFields } from "./executor-triggers.js";
import { countDuePendingEnvelopesForAgent } from "./executor-db.js";
import { getOrCreateAgentSession } from "./executor-session.js";
import type { Envelope } from "../envelope/types.js";
import {
  AgentRunTimeoutError,
  AgentToolCallTimeoutError,
  executeUnifiedTurn,
  type RuntimeEvent,
} from "./executor-turn.js";

/**
 * Maximum number of pending envelopes to process in a single turn.
 */
const MAX_ENVELOPES_PER_TURN = 10;
const AGENT_RUN_WAIT_LOG_INTERVAL_MS = 30000;
const AGENT_MISSING_CHANNEL_REPLY_MAX_RECOVERY_ATTEMPTS = 1;
const AGENT_RECOVERY_PROMPT_MESSAGE_PREVIEW_CHARS = 500;
const AGENT_TOOL_CALL_TIMEOUT_MS = 45000;
const AGENT_TOOL_TIMEOUT_RECOVERY_MAX_ATTEMPTS = 1;

function addNullableTokenCount(total: number | null, next: number | null): number | null {
  if (total === null && next === null) return null;
  return (total ?? 0) + (next ?? 0);
}

function mergeTurnUsage(total: TurnTokenUsage | null, next: TurnTokenUsage): TurnTokenUsage {
  if (!total) return next;
  return {
    contextLength: next.contextLength ?? total.contextLength,
    inputTokens: addNullableTokenCount(total.inputTokens, next.inputTokens),
    outputTokens: addNullableTokenCount(total.outputTokens, next.outputTokens),
    cacheReadTokens: addNullableTokenCount(total.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: addNullableTokenCount(total.cacheWriteTokens, next.cacheWriteTokens),
    totalTokens: addNullableTokenCount(total.totalTokens, next.totalTokens),
  };
}

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
      const requiredChannelReplyAddresses = this.collectRequiredChannelReplyAddresses(envelopes);

      // Execute the turn
      let response = "";
      let usage: TurnTokenUsage | null = null;
      try {
        const firstTurn = await this.executeTurnWithToolTimeoutRecovery({
          session,
          turnInput,
          signal: inFlight.abortController.signal,
          onRunHandle: (handle) => {
            inFlight.runHandle = handle;
          },
          onEvent: handleEvent,
          interactionTimeoutMs: timeoutMs,
          agentName: agent.name,
          runId: run.id,
          envelopes,
        });
        if (firstTurn.status === "cancelled") {
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
        response = firstTurn.finalText;
        usage = mergeTurnUsage(usage, firstTurn.usage);

        if (requiredChannelReplyAddresses.length > 0 && runStartedAtMs) {
          let missingChannelReplyAddresses = this.getMissingChannelReplyAddresses(
            db,
            agent.name,
            requiredChannelReplyAddresses,
            runStartedAtMs
          );
          let recoveryAttempt = 0;

          while (
            missingChannelReplyAddresses.length > 0 &&
            recoveryAttempt < AGENT_MISSING_CHANNEL_REPLY_MAX_RECOVERY_ATTEMPTS
          ) {
            recoveryAttempt += 1;
            logEvent("warn", "agent-run-missing-channel-reply", {
              "agent-name": agent.name,
              "agent-run-id": run.id,
              attempt: recoveryAttempt,
              "required-channel-to": requiredChannelReplyAddresses.join(","),
              "missing-channel-to": missingChannelReplyAddresses.join(","),
            });
            const recoveryTurnInput = this.buildMissingChannelReplyTurnInput({
              missingChannelReplyAddresses,
              envelopes,
              attempt: recoveryAttempt,
            });
            const recoveryTurn = await this.executeTurnWithToolTimeoutRecovery({
              session,
              turnInput: recoveryTurnInput,
              signal: inFlight.abortController.signal,
              onRunHandle: (handle) => {
                inFlight.runHandle = handle;
              },
              onEvent: handleEvent,
              interactionTimeoutMs: timeoutMs,
              agentName: agent.name,
              runId: run.id,
              envelopes,
            });
            if (recoveryTurn.status === "cancelled") {
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
            response = recoveryTurn.finalText;
            usage = mergeTurnUsage(usage, recoveryTurn.usage);
            missingChannelReplyAddresses = this.getMissingChannelReplyAddresses(
              db,
              agent.name,
              requiredChannelReplyAddresses,
              runStartedAtMs
            );
          }

          if (missingChannelReplyAddresses.length > 0) {
            throw new Error(
              `Agent run completed without required channel reply to: ${missingChannelReplyAddresses.join(", ")}`
            );
          }

          if (recoveryAttempt > 0) {
            logEvent("info", "agent-run-missing-channel-reply-recovered", {
              "agent-name": agent.name,
              "agent-run-id": run.id,
              attempts: recoveryAttempt,
              "required-channel-to": requiredChannelReplyAddresses.join(","),
            });
          }
        }
      } finally {
        stopWaitLogger();
      }

      if (!usage) {
        throw new Error("Missing turn usage");
      }
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
      db.completeAgentRun(run.id, response, usage.contextLength);

      logEvent("info", "agent-run-complete", {
        "agent-name": agent.name,
        "agent-run-id": run.id,
        state: "success",
        "duration-ms": runStartedAtMs ? Date.now() - runStartedAtMs : 0,
        "context-length": usage.contextLength,
        "input-tokens": usage.inputTokens,
        "output-tokens": usage.outputTokens,
        "cache-read-tokens": usage.cacheReadTokens,
        "cache-write-tokens": usage.cacheWriteTokens,
        "total-tokens": usage.totalTokens,
      });

      // Context-length refresh: if a run grew the context too large, reset the session for the next run.
      const policy = this.getSessionPolicy(agent);
      if (
        typeof policy.maxContextLength === "number" &&
        usage.contextLength !== null &&
        usage.contextLength > policy.maxContextLength
      ) {
        await this.refreshSession(
          agent.name,
          `max-context-length:${usage.contextLength}>${policy.maxContextLength}`
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
   * Execute one turn, and if a tool call times out, run one recovery turn
   * that asks the model to switch strategy.
   */
  private async executeTurnWithToolTimeoutRecovery(params: {
    session: AgentSession;
    turnInput: string;
    signal?: AbortSignal;
    onRunHandle?: (handle: RunHandle) => void;
    onEvent?: (event: RuntimeEvent) => void | Promise<void>;
    interactionTimeoutMs: number;
    agentName: string;
    runId: string;
    envelopes: Envelope[];
  }): Promise<{ status: "success" | "cancelled"; finalText: string; usage: TurnTokenUsage }> {
    let input = params.turnInput;
    let attempt = 0;

    while (true) {
      const turnAttempt = attempt + 1;
      try {
        return await executeUnifiedTurn(params.session, input, {
          signal: params.signal,
          onRunHandle: params.onRunHandle,
          onEvent: params.onEvent,
          timeoutMs: params.interactionTimeoutMs,
          toolTimeoutMs: AGENT_TOOL_CALL_TIMEOUT_MS,
          requireBashTimeoutHint: true,
          onToolExecutionStart: (event) => {
            logEvent("info", "agent-run-tool-start", {
              "agent-name": params.agentName,
              "agent-run-id": params.runId,
              attempt: turnAttempt,
              "tool-started-at": new Date(event.startedAtMs).toISOString(),
              "tool-queued-ms": event.queuedMs,
              ...(event.timeoutMs !== undefined ? { "tool-timeout-ms": event.timeoutMs } : {}),
              ...(event.toolName ? { "tool-name": event.toolName } : {}),
              ...(event.callId ? { "tool-call-id": event.callId } : {}),
              ...(event.commandPreview ? { "tool-command-preview": event.commandPreview } : {}),
              ...(event.isHiBossCommand ? { "tool-timeout-exempt": true } : {}),
              ...(event.timeoutHintState ? { "tool-timeout-hint-state": event.timeoutHintState } : {}),
              ...(event.timeoutHintRaw ? { "tool-timeout-hint": event.timeoutHintRaw } : {}),
            });
          },
        });
      } catch (err) {
        if (!(err instanceof AgentToolCallTimeoutError) || attempt >= AGENT_TOOL_TIMEOUT_RECOVERY_MAX_ATTEMPTS) {
          throw err;
        }
        attempt += 1;
        logEvent("warn", "agent-run-tool-timeout", {
          "agent-name": params.agentName,
          "agent-run-id": params.runId,
          attempt,
          "tool-timeout-ms": err.toolTimeoutMs,
          ...(err.toolName ? { "tool-name": err.toolName } : {}),
          ...(err.callId ? { "tool-call-id": err.callId } : {}),
          ...(err.commandPreview ? { "tool-command-preview": err.commandPreview } : {}),
          ...(err.timeoutHintState ? { "tool-timeout-hint-state": err.timeoutHintState } : {}),
          ...(err.timeoutHintRaw ? { "tool-timeout-hint": err.timeoutHintRaw } : {}),
        });
        input = this.buildToolTimeoutRecoveryTurnInput({
          envelopes: params.envelopes,
          attempt,
          toolTimeoutMs: err.toolTimeoutMs,
          toolName: err.toolName,
          commandPreview: err.commandPreview,
          timeoutHintState:
            err.timeoutHintState === "missing" || err.timeoutHintState === "invalid"
              ? err.timeoutHintState
              : undefined,
        });
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

  private collectRequiredChannelReplyAddresses(envelopes: Envelope[]): string[] {
    const addresses = new Set<string>();
    for (const envelope of envelopes) {
      if (typeof envelope.from === "string" && envelope.from.startsWith("channel:")) {
        addresses.add(envelope.from);
      }
    }
    return Array.from(addresses);
  }

  private getMissingChannelReplyAddresses(
    db: HiBossDatabase,
    agentName: string,
    requiredChannelReplyAddresses: string[],
    sinceMs: number
  ): string[] {
    const sent = new Set(
      db.getSentToAddressesForAgentSince(agentName, requiredChannelReplyAddresses, sinceMs)
    );
    return requiredChannelReplyAddresses.filter((address) => !sent.has(address));
  }

  private buildMissingChannelReplyTurnInput(params: {
    missingChannelReplyAddresses: string[];
    envelopes: Envelope[];
    attempt: number;
  }): string {
    const latestEnvelope = params.envelopes[params.envelopes.length - 1];
    const latestText = latestEnvelope?.content.text?.trim() ?? "";
    const latestPreview = latestText
      ? latestText.slice(0, AGENT_RECOVERY_PROMPT_MESSAGE_PREVIEW_CHARS)
      : "(empty)";
    return [
      "## Delivery Recovery",
      `Attempt: ${params.attempt}.`,
      "The previous turn completed without sending a channel reply.",
      `You MUST send a reply now via \`hiboss envelope send\` to: ${params.missingChannelReplyAddresses.join(", ")}.`,
      "Do not only print plain text. Execute the send command now.",
      "If context is missing, send a short acknowledgement and one clarifying question.",
      `Latest user message:\n${latestPreview}`,
    ].join("\n\n");
  }

  private buildToolTimeoutRecoveryTurnInput(params: {
    envelopes: Envelope[];
    attempt: number;
    toolTimeoutMs: number;
    toolName?: string;
    commandPreview?: string;
    timeoutHintState?: "missing" | "invalid";
  }): string {
    const latestEnvelope = params.envelopes[params.envelopes.length - 1];
    const latestText = latestEnvelope?.content.text?.trim() ?? "";
    const latestPreview = latestText
      ? latestText.slice(0, AGENT_RECOVERY_PROMPT_MESSAGE_PREVIEW_CHARS)
      : "(empty)";
    const timeoutSeconds = Math.max(1, Math.round(params.toolTimeoutMs / 1000));
    const toolLabel = params.toolName ? params.toolName : "tool";
    return [
      "## Tool Timeout Recovery",
      `Attempt: ${params.attempt}.`,
      params.timeoutHintState === "missing"
        ? `Your previous ${toolLabel} call did not include a timeout hint.`
        : "",
      params.timeoutHintState === "invalid"
        ? `Your previous ${toolLabel} call used an invalid timeout hint.`
        : "",
      `Your previous ${toolLabel} command timed out after ${timeoutSeconds}s.`,
      params.commandPreview ? `Timed out command preview:\n${params.commandPreview}` : "",
      "Every non-Hi-Boss Bash call MUST include an expected timeout in the description.",
      "Use one of these formats: `timeout=8s`, `timeout: 30s`, or `max-time=2m`.",
      "Do not add timeout hints to `hiboss ...` commands.",
      "Do NOT continue diagnostic probing in this recovery turn.",
      "In this recovery turn, the only Bash command you should run is `hiboss envelope send`.",
      "If verification needs admin access or keeps timing out, state the limitation clearly and give a best-effort answer.",
      "Send the user reply now via `hiboss envelope send` instead of running more system checks.",
      `Latest user message:\n${latestPreview}`,
    ]
      .filter((line) => line !== "")
      .join("\n\n");
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
