import type { RunHandle } from "@unified-agent-sdk/runtime";
import type { AgentSession, TurnTokenUsage } from "./executor-support.js";
import { readTokenUsage } from "./executor-support.js";

export type RuntimeEvent = {
  type?: string;
  [key: string]: unknown;
};

export class AgentRunTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunTimeoutError";
  }
}

export class AgentToolCallTimeoutError extends Error {
  toolName?: string;
  callId?: string;
  toolTimeoutMs: number;
  commandPreview?: string;
  timeoutHintState?: ToolTimeoutHintState;
  timeoutHintRaw?: string;

  constructor(params: {
    toolTimeoutMs: number;
    toolName?: string;
    callId?: string;
    commandPreview?: string;
    timeoutHintState?: ToolTimeoutHintState;
    timeoutHintRaw?: string;
  }) {
    const seconds = Math.round(params.toolTimeoutMs / 1000);
    const tool = params.toolName ? `Tool ${params.toolName}` : "Tool";
    const call = params.callId ? ` (${params.callId})` : "";
    super(`${tool}${call} timed out after ${seconds}s`);
    this.name = "AgentToolCallTimeoutError";
    this.toolName = params.toolName;
    this.callId = params.callId;
    this.toolTimeoutMs = params.toolTimeoutMs;
    this.commandPreview = params.commandPreview;
    this.timeoutHintState = params.timeoutHintState;
    this.timeoutHintRaw = params.timeoutHintRaw;
  }
}

export type ToolTimeoutHintState = "ok" | "missing" | "invalid";

export type ToolExecutionStartInfo = {
  toolName?: string;
  callId?: string;
  commandPreview?: string;
  timeoutMs?: number;
  startedAtMs: number;
  queuedMs: number;
  timeoutHintState?: ToolTimeoutHintState;
  timeoutHintRaw?: string;
  isHiBossCommand: boolean;
};

export interface ExecuteUnifiedTurnOptions {
  signal?: AbortSignal;
  onRunHandle?: (handle: RunHandle) => void;
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
  timeoutMs?: number;
  toolTimeoutMs?: number;
  requireBashTimeoutHint?: boolean;
  onToolExecutionStart?: (event: ToolExecutionStartInfo) => void | Promise<void>;
}

function notifyEvent<T>(handler: (event: T) => void | Promise<void>, event: T): void {
  try {
    const maybePromise = handler(event);
    if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
      (maybePromise as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Swallow handler errors to avoid disrupting the run.
  }
}

export async function executeUnifiedTurn(
  session: AgentSession,
  turnInput: string,
  options: ExecuteUnifiedTurnOptions = {}
): Promise<{ status: "success" | "cancelled"; finalText: string; usage: TurnTokenUsage }> {
  const config = options.signal ? { signal: options.signal } : undefined;

  const runHandle = await session.session.run({
    input: { parts: [{ type: "text", text: turnInput }] },
    ...(config ? { config } : {}),
  });
  // Avoid unhandled rejections if we time out and stop awaiting the result.
  void runHandle.result.catch(() => undefined);

  options.onRunHandle?.(runHandle);

  const onEvent = options.onEvent;
  const onToolExecutionStart = options.onToolExecutionStart;
  const toolTimeoutMs = options.toolTimeoutMs;
  const hasToolTimeout = typeof toolTimeoutMs === "number" && Number.isFinite(toolTimeoutMs) && toolTimeoutMs > 0;
  const requireBashTimeoutHint = options.requireBashTimeoutHint === true;
  let toolTimedOut = false;
  let anonymousToolCounter = 0;
  type PendingToolCall = {
    key: string;
    callId?: string;
    toolName?: string;
    commandPreview?: string;
    timeoutMs?: number;
    timeoutHintState?: ToolTimeoutHintState;
    timeoutHintRaw?: string;
    isHiBossCommand: boolean;
    queuedAtMs: number;
    startedAtMs?: number;
    timer?: NodeJS.Timeout;
  };
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const pendingToolQueue: string[] = [];
  let rejectToolTimeout: ((error: AgentToolCallTimeoutError) => void) | null = null;
  const toolTimeoutPromise = hasToolTimeout
    ? new Promise<never>((_, reject) => {
      rejectToolTimeout = reject as (error: AgentToolCallTimeoutError) => void;
    })
    : null;

  const clearToolTimer = (key: string): void => {
    const tool = pendingToolCalls.get(key);
    if (!tool?.timer) return;
    clearTimeout(tool.timer);
    tool.timer = undefined;
  };

  const clearAllToolTimers = (): void => {
    for (const key of pendingToolCalls.keys()) {
      clearToolTimer(key);
    }
    pendingToolCalls.clear();
    pendingToolQueue.length = 0;
  };

  const getEventString = (event: RuntimeEvent, key: string): string | undefined => {
    const value = event[key];
    return typeof value === "string" ? value : undefined;
  };

  const summarizeCommand = (event: RuntimeEvent): string | undefined => {
    const direct =
      getEventString(event, "command") ??
      getEventString(event, "cmd") ??
      getEventString(event, "query");
    if (direct && direct.trim()) {
      return direct.trim().slice(0, 160);
    }
    const input = event.input;
    if (!input || typeof input !== "object") return undefined;
    const record = input as Record<string, unknown>;
    for (const key of ["command", "cmd", "query", "code", "sql", "path", "text"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim().slice(0, 160);
      }
    }
    return undefined;
  };

  const parseTimeoutHintMs = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 0 ? Math.round(value) : null;
    }
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h)?$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = (match[2] ?? "s").toLowerCase();
    if (unit === "ms") return Math.round(amount);
    if (unit === "s") return Math.round(amount * 1000);
    if (unit === "m") return Math.round(amount * 60_000);
    if (unit === "h") return Math.round(amount * 3_600_000);
    return null;
  };

  const extractTimeoutHintFromDescription = (description: string): string | null => {
    const pattern = /(?:timeout|time[- ]?limit|max[- ]?time)\s*[:=]\s*([0-9]+(?:\.[0-9]+)?\s*(?:ms|s|m|h)?)/i;
    const match = description.match(pattern);
    return match ? match[1] : null;
  };

  const readToolTimeoutHint = (event: RuntimeEvent): {
    timeoutMs?: number;
    hintRaw?: string;
    hintPresent: boolean;
  } => {
    const candidates: unknown[] = [];
    for (const key of [
      "timeoutMs",
      "timeout_ms",
      "timeout",
      "maxDurationMs",
      "max_duration_ms",
      "maxDuration",
      "max_duration",
    ]) {
      if (key in event) {
        candidates.push(event[key]);
      }
    }

    const input = event.input;
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      for (const key of [
        "timeoutMs",
        "timeout_ms",
        "timeout",
        "maxDurationMs",
        "max_duration_ms",
        "maxDuration",
        "max_duration",
      ]) {
        if (key in record) {
          candidates.push(record[key]);
        }
      }
      if (typeof record.description === "string" && record.description.trim()) {
        const descriptionHint = extractTimeoutHintFromDescription(record.description);
        if (descriptionHint) {
          candidates.push(descriptionHint);
        }
      }
    }

    if (candidates.length === 0) return { hintPresent: false };
    for (const value of candidates) {
      const parsed = parseTimeoutHintMs(value);
      if (parsed !== null) {
        return {
          timeoutMs: parsed,
          hintRaw: typeof value === "string" ? value : String(value),
          hintPresent: true,
        };
      }
    }
    const first = candidates[0];
    return {
      hintPresent: true,
      hintRaw: typeof first === "string" ? first : String(first),
    };
  };

  const resolveTimeoutHintState = (
    isBash: boolean,
    isHiBossCommand: boolean,
    timeoutHint: { timeoutMs?: number; hintRaw?: string; hintPresent: boolean }
  ): ToolTimeoutHintState | undefined => {
    if (!isBash || isHiBossCommand || !requireBashTimeoutHint) return undefined;
    if (timeoutHint.timeoutMs !== undefined) return "ok";
    return timeoutHint.hintPresent ? "invalid" : "missing";
  };

  const startNextPendingTool = (): void => {
    if (toolTimedOut) return;
    const key = pendingToolQueue[0];
    if (!key) return;
    const tool = pendingToolCalls.get(key);
    if (!tool || tool.startedAtMs !== undefined) return;
    const startedAtMs = Date.now();
    tool.startedAtMs = startedAtMs;
    if (onToolExecutionStart) {
      notifyEvent(onToolExecutionStart, {
        toolName: tool.toolName,
        callId: tool.callId,
        commandPreview: tool.commandPreview,
        timeoutMs: tool.timeoutMs,
        startedAtMs,
        queuedMs: startedAtMs - tool.queuedAtMs,
        timeoutHintState: tool.timeoutHintState,
        timeoutHintRaw: tool.timeoutHintRaw,
        isHiBossCommand: tool.isHiBossCommand,
      } satisfies ToolExecutionStartInfo);
    }
    if (!hasToolTimeout || !rejectToolTimeout || tool.timeoutMs === undefined) return;
    const activeTimeoutMs = tool.timeoutMs;
    tool.timer = setTimeout(() => {
      toolTimedOut = true;
      clearToolTimer(key);
      pendingToolCalls.delete(key);
      const index = pendingToolQueue.indexOf(key);
      if (index !== -1) {
        pendingToolQueue.splice(index, 1);
      }
      void runHandle.cancel?.();
      rejectToolTimeout?.(
        new AgentToolCallTimeoutError({
          toolTimeoutMs: activeTimeoutMs,
          toolName: tool.toolName,
          callId: tool.callId,
          commandPreview: tool.commandPreview,
          timeoutHintState: tool.timeoutHintState,
          timeoutHintRaw: tool.timeoutHintRaw,
        })
      );
    }, activeTimeoutMs);
  };

  const queueToolCall = (tool: PendingToolCall): void => {
    if (pendingToolCalls.has(tool.key)) {
      clearToolTimer(tool.key);
      const existingIndex = pendingToolQueue.indexOf(tool.key);
      if (existingIndex !== -1) {
        pendingToolQueue.splice(existingIndex, 1);
      }
    }
    pendingToolCalls.set(tool.key, tool);
    pendingToolQueue.push(tool.key);
    startNextPendingTool();
  };

  const completeToolCall = (callId?: string): void => {
    const key =
      callId && pendingToolCalls.has(callId)
        ? callId
        : pendingToolQueue.length > 0
          ? pendingToolQueue[0]
          : undefined;
    if (!key) return;
    const index = pendingToolQueue.indexOf(key);
    if (index === -1) return;
    const wasActive = index === 0;
    clearToolTimer(key);
    pendingToolCalls.delete(key);
    pendingToolQueue.splice(index, 1);
    if (wasActive) {
      startNextPendingTool();
    }
  };

  const maybeTrackToolTimeout = (event: RuntimeEvent): void => {
    if (!hasToolTimeout && !onToolExecutionStart) return;
    const eventType = typeof event.type === "string" ? event.type : "unknown";
    if (eventType === "tool.call") {
      const callId = getEventString(event, "callId");
      const key = callId ?? `__anon_tool_call_${anonymousToolCounter++}`;
      const toolName = getEventString(event, "toolName") ?? getEventString(event, "name");
      const commandPreview = summarizeCommand(event);
      const isBash = toolName === "Bash";
      const isHiBossCommand =
        isBash &&
        typeof commandPreview === "string" &&
        /(^|\s)hiboss(?:\s|$)/i.test(commandPreview);
      const timeoutHint = readToolTimeoutHint(event);
      const timeoutHintState = resolveTimeoutHintState(isBash, isHiBossCommand, timeoutHint);
      const effectiveToolTimeoutMs =
        !isHiBossCommand && hasToolTimeout && toolTimeoutMs
          ? timeoutHint.timeoutMs ?? toolTimeoutMs
          : undefined;
      queueToolCall({
        key,
        callId,
        toolName,
        commandPreview,
        timeoutMs: effectiveToolTimeoutMs,
        timeoutHintState,
        timeoutHintRaw: timeoutHint.hintRaw,
        isHiBossCommand,
        queuedAtMs: Date.now(),
      });
      return;
    }
    if (eventType === "tool.result" || eventType === "tool.error") {
      const callId = getEventString(event, "callId");
      completeToolCall(callId);
    }
  };

  const eventsTask = (async () => {
    for await (const event of runHandle.events) {
      // Events must be consumed for the run to complete
      maybeTrackToolTimeout(event as RuntimeEvent);
      if (onEvent) {
        notifyEvent(onEvent, event as RuntimeEvent);
      }
    }
  })();

  const timeoutMs = options.timeoutMs;
  let timeoutId: NodeJS.Timeout | null = null;
  let runTimedOut = false;
  let result: Awaited<typeof runHandle.result>;
  try {
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          runTimedOut = true;
          void runHandle.cancel?.();
          reject(new AgentRunTimeoutError(`Agent run timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      });
      const raceTasks: Promise<Awaited<typeof runHandle.result>>[] = [runHandle.result, timeoutPromise];
      if (toolTimeoutPromise) {
        raceTasks.push(toolTimeoutPromise);
      }
      result = await Promise.race(raceTasks);
    } else {
      const raceTasks: Promise<Awaited<typeof runHandle.result>>[] = [runHandle.result];
      if (toolTimeoutPromise) {
        raceTasks.push(toolTimeoutPromise);
      }
      result = await Promise.race(raceTasks);
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    clearAllToolTimers();
    const drain = eventsTask.catch(() => undefined);
    if (runTimedOut || toolTimedOut) {
      await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 2000))]);
    } else {
      await drain;
    }
  }

  if (result.status === "cancelled") {
    return { status: "cancelled", finalText: "", usage: readTokenUsage(result.usage) };
  }

  if (result.status !== "success") {
    throw new Error(`Agent run ${result.status}`);
  }

  const usage = readTokenUsage(result.usage);
  return { status: "success", finalText: result.finalText ?? "", usage };
}
