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

export interface ExecuteUnifiedTurnOptions {
  signal?: AbortSignal;
  onRunHandle?: (handle: RunHandle) => void;
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
  timeoutMs?: number;
}

function notifyEvent(handler: (event: RuntimeEvent) => void | Promise<void>, event: RuntimeEvent): void {
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
  const eventsTask = (async () => {
    for await (const event of runHandle.events) {
      // Events must be consumed for the run to complete
      if (onEvent) {
        notifyEvent(onEvent, event as RuntimeEvent);
      }
    }
  })();

  const timeoutMs = options.timeoutMs;
  let timeoutId: NodeJS.Timeout | null = null;
  let timedOut = false;
  let result: Awaited<typeof runHandle.result>;
  try {
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          void runHandle.cancel?.();
          reject(new AgentRunTimeoutError(`Agent run timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      });
      result = await Promise.race([runHandle.result, timeoutPromise]);
    } else {
      result = await runHandle.result;
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    const drain = eventsTask.catch(() => undefined);
    if (timedOut) {
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
