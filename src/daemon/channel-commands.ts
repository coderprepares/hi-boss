import type { ChannelCommand, ChannelCommandHandler, MessageContent } from "../adapters/types.js";
import type { BackgroundExecutor } from "../agent/background-executor.js";
import type { HiBossDatabase } from "./db/database.js";
import type { AgentExecutor } from "../agent/executor.js";
import { getTelegramVerboseEnabled, setTelegramVerboseEnabled } from "./telegram-status-config.js";
import { buildAgentStatusResult } from "./agent-status.js";
import { renderAgentStatusText } from "../shared/agent-status-output.js";
import { AGENT_NAME_ERROR_MESSAGE, isValidAgentName } from "../shared/validation.js";

type EnrichedChannelCommand = ChannelCommand & { agentName?: string };

function commandReason(command: EnrichedChannelCommand): string {
  const platform = typeof command.platform === "string" && command.platform.trim()
    ? command.platform.trim()
    : "telegram";
  return `${platform}:/${command.command}`;
}

function resolveTargetAgentName(command: EnrichedChannelCommand): { agentName: string } | { error: string } {
  if (typeof command.agentName !== "string" || !command.agentName) {
    return { error: "error: Agent not found" };
  }

  const args = command.args.trim();
  if (!args) {
    return { agentName: command.agentName };
  }

  const parts = args.split(/\s+/);
  if (parts.length !== 1) {
    return { error: `error: usage /${command.command} [agent-name]` };
  }

  if (!isValidAgentName(parts[0])) {
    return { error: `error: ${AGENT_NAME_ERROR_MESSAGE}` };
  }

  return { agentName: parts[0] };
}

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

function buildChannelHelpText(platform: string | undefined): string {
  const lines = [
    "Hi-Boss commands:",
    "/help - show this help",
    "/new [agent-name] - request a fresh session",
    "/status [agent-name] - show agent status",
    "/abort - cancel current run and clear due pending inbox",
  ];
  if (platform === "telegram") {
    lines.push("/verbose - show verbose mode");
    lines.push("/verbose on|off - toggle runtime status updates");
  }
  lines.push("Commands are boss-only.");
  return lines.join("\n");
}

export function createChannelCommandHandler(params: {
  db: HiBossDatabase;
  executor: AgentExecutor;
  backgroundExecutor: BackgroundExecutor;
}): ChannelCommandHandler {
  return (command): MessageContent | void => {
    const c = command as EnrichedChannelCommand;
    if (typeof c.command !== "string") return;

    if (c.command === "help") {
      return { text: buildChannelHelpText(c.platform) };
    }

    if (c.command === "new" && typeof c.agentName === "string" && c.agentName) {
      const target = resolveTargetAgentName(c);
      if ("error" in target) {
        return { text: target.error };
      }

      const agent = params.db.getAgentByNameCaseInsensitive(target.agentName);
      if (!agent) {
        return { text: "error: Agent not found" };
      }

      params.executor.requestSessionRefresh(agent.name, commandReason(c));
      if (agent.name === c.agentName) {
        return { text: "Session refresh requested." };
      }
      return { text: `Session refresh requested.\nagent-name: ${agent.name}` };
    }

    if (c.command === "status" && typeof c.agentName === "string" && c.agentName) {
      const target = resolveTargetAgentName(c);
      if ("error" in target) {
        return { text: target.error };
      }

      return {
        text: buildAgentStatusText({
          db: params.db,
          executor: params.executor,
          backgroundExecutor: params.backgroundExecutor,
          agentName: target.agentName,
        }),
      };
    }

    if (c.command === "abort" && typeof c.agentName === "string" && c.agentName) {
      const cancelledRun = params.executor.abortCurrentRun(c.agentName, commandReason(c));
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
