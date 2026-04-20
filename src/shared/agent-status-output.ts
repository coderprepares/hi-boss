import type { AgentStatusResult } from "../daemon/ipc/types.js";
import { formatShortId } from "./id-format.js";
import { formatUnixMsAsTimeZoneOffset } from "./time.js";

export function renderAgentStatusText(result: AgentStatusResult, bossTimezone: string): string {
  const lines: string[] = [];

  lines.push(`name: ${result.agent.name}`);
  lines.push(`role: ${result.agent.role ?? "(missing)"}`);
  lines.push(`workspace: ${result.effective.workspace}`);
  lines.push(`provider: ${result.effective.provider}`);
  lines.push(`model: ${result.agent.model ?? "default"}`);
  lines.push(`reasoning-effort: ${result.agent.reasoningEffort ?? "default"}`);
  lines.push(`permission-level: ${result.effective.permissionLevel}`);
  lines.push(`bindings: ${result.bindings.length > 0 ? result.bindings.join(", ") : "(none)"}`);

  if (result.agent.sessionPolicy && typeof result.agent.sessionPolicy === "object") {
    const sessionPolicy = result.agent.sessionPolicy as Record<string, unknown>;
    if (typeof sessionPolicy.dailyResetAt === "string") {
      lines.push(`session-daily-reset-at: ${sessionPolicy.dailyResetAt}`);
    }
    if (typeof sessionPolicy.idleTimeout === "string") {
      lines.push(`session-idle-timeout: ${sessionPolicy.idleTimeout}`);
    }
    if (typeof sessionPolicy.maxContextLength === "number") {
      lines.push(`session-max-context-length: ${sessionPolicy.maxContextLength}`);
    }
  }

  lines.push(`agent-state: ${result.status.agentState}`);
  lines.push(`agent-health: ${result.status.agentHealth}`);
  lines.push(`pending-count: ${result.status.pendingCount}`);

  lines.push(`background-state: ${result.status.background.state}`);
  lines.push(`background-running-count: ${result.status.background.runningCount}`);
  lines.push(`background-queued-count: ${result.status.background.queuedCount}`);
  lines.push(`background-open-count: ${result.status.background.openCount}`);

  if (result.status.currentRun) {
    lines.push(`current-run-id: ${formatShortId(result.status.currentRun.id)}`);
    lines.push(
      `current-run-started-at: ${formatUnixMsAsTimeZoneOffset(result.status.currentRun.startedAt, bossTimezone)}`
    );
  }

  if (!result.status.lastRun) {
    lines.push("last-run-status: none");
    return lines.join("\n");
  }

  lines.push(`last-run-id: ${formatShortId(result.status.lastRun.id)}`);
  lines.push(`last-run-status: ${result.status.lastRun.status}`);
  lines.push(`last-run-started-at: ${formatUnixMsAsTimeZoneOffset(result.status.lastRun.startedAt, bossTimezone)}`);
  if (typeof result.status.lastRun.completedAt === "number") {
    lines.push(
      `last-run-completed-at: ${formatUnixMsAsTimeZoneOffset(result.status.lastRun.completedAt, bossTimezone)}`
    );
  }
  if (typeof result.status.lastRun.contextLength === "number") {
    lines.push(`last-run-context-length: ${result.status.lastRun.contextLength}`);
  }
  if (
    (result.status.lastRun.status === "failed" || result.status.lastRun.status === "cancelled") &&
    result.status.lastRun.error
  ) {
    lines.push(`last-run-error: ${result.status.lastRun.error}`);
  }

  return lines.join("\n");
}
