import type { ChannelCommand, ChannelCommandHandler, MessageContent } from "../adapters/types.js";
import type { BackgroundExecutor } from "../agent/background-executor.js";
import type { HiBossDatabase } from "./db/database.js";
import type { AgentExecutor } from "../agent/executor.js";
import { getTelegramVerboseEnabled, setTelegramVerboseEnabled } from "./telegram-status-config.js";
import { buildAgentStatusResult } from "./agent-status.js";
import { renderAgentStatusText } from "../shared/agent-status-output.js";

type EnrichedChannelCommand = ChannelCommand & { agentName?: string };

function buildAgentStatusText(params: {
  db: HiBossDatabase;
  executor: AgentExecutor;
  backgroundExecutor: BackgroundExecutor;
  agentName: string;
}): string {
  const agent = params.db.getAgentByNameCaseInsensitive(params.agentName);
  if (!agent) {
    return "error: Agent not found";
  }

  const result = buildAgentStatusResult({
    db: params.db,
    executor: params.executor,
    backgroundExecutor: params.backgroundExecutor,
    agent,
  });
  return renderAgentStatusText(result, params.db.getBossTimezone());
}

export function createChannelCommandHandler(params: {
  db: HiBossDatabase;
  executor: AgentExecutor;
  backgroundExecutor: BackgroundExecutor;
}): ChannelCommandHandler {
  return (command): MessageContent | void => {
    const c = command as EnrichedChannelCommand;
    if (typeof c.command !== "string") return;

    if (c.command === "new" && typeof c.agentName === "string" && c.agentName) {
      params.executor.requestSessionRefresh(c.agentName, "telegram:/new");
      return { text: "Session refresh requested." };
    }

    if (c.command === "status" && typeof c.agentName === "string" && c.agentName) {
      return {
        text: buildAgentStatusText({
          db: params.db,
          executor: params.executor,
          backgroundExecutor: params.backgroundExecutor,
          agentName: c.agentName,
        }),
      };
    }

    if (c.command === "abort" && typeof c.agentName === "string" && c.agentName) {
      const cancelledRun = params.executor.abortCurrentRun(c.agentName, "telegram:/abort");
      const clearedPendingCount = params.db.markDuePendingNonCronEnvelopesDoneForAgent(c.agentName);
      const lines = [
        "abort: ok",
        `agent-name: ${c.agentName}`,
        `cancelled-run: ${cancelledRun ? "true" : "false"}`,
        `cleared-pending-count: ${clearedPendingCount}`,
      ];
      return { text: lines.join("\n") };
    }

    if (c.command === "verbose") {
      const current = getTelegramVerboseEnabled(params.db, c.chatId);
      const arg = c.args.trim().toLowerCase();

      if (!arg) {
        return { text: `verbose: ${current ? "on" : "off"}` };
      }

      if (arg === "on" || arg === "off") {
        const enabled = arg === "on";
        setTelegramVerboseEnabled(params.db, c.chatId, enabled);
        return { text: `verbose: ${enabled ? "on" : "off"}` };
      }

      return { text: "error: usage /verbose on|off" };
    }
  };
}
