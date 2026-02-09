import type { RunHandle } from "@unified-agent-sdk/runtime";
import type { AgentSession, TurnTokenUsage } from "./executor-support.js";
import { readTokenUsage } from "./executor-support.js";

export type RuntimeEvent = {
  type?: string;
  [key: string]: unknown;
};

export interface ExecuteUnifiedTurnOptions {
  signal?: AbortSignal;
  onRunHandle?: (handle: RunHandle) => void;
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
}

function notifyEvent(handler: (event: RuntimeEvent) => void | Promise<void>, event: RuntimeEvent): void {
  try {
    const maybePromise = handler(event);
    if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
      (maybePromise as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Swallow callback errors so they cannot interrupt the run.
  }
}

export async function executeUnifiedTurn(
  session: AgentSession,
  turnInput: string,
  options: ExecuteUnifiedTurnOptions = {}
): Promise<{ status: "success" | "cancelled"; finalText: string; usage: TurnTokenUsage }> {
  const config = options?.signal ? { signal: options.signal } : undefined;

  const runHandle = await session.session.run({
    input: { parts: [{ type: "text", text: turnInput }] },
    ...(config ? { config } : {}),
  });

  options?.onRunHandle?.(runHandle);

  // Drain events (required for run completion)
  for await (const event of runHandle.events) {
    // Events must be consumed for the run to complete
    if (options.onEvent) {
      notifyEvent(options.onEvent, event as RuntimeEvent);
    }
  }

  const result = await runHandle.result;

  if (result.status === "cancelled") {
    return { status: "cancelled", finalText: "", usage: readTokenUsage(result.usage) };
  }

  if (result.status !== "success") {
    throw new Error(`Agent run ${result.status}`);
  }

  const usage = readTokenUsage(result.usage);
  return { status: "success", finalText: result.finalText ?? "", usage };
}
