import type { Agent } from "../agent/types.js";
import type { BackgroundExecutor } from "../agent/background-executor.js";
import type { AgentExecutor } from "../agent/executor.js";
import type { AgentStatusResult } from "./ipc/types.js";
import type { HiBossDatabase } from "./db/database.js";
import {
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_AGENT_PROVIDER,
  getDefaultRuntimeWorkspace,
} from "../shared/defaults.js";
import { parseAgentRoleFromMetadata } from "../shared/agent-role.js";

function requireAgentRole(agent: Agent): "speaker" | "leader" {
  const role = parseAgentRoleFromMetadata(agent.metadata);
  if (!role) {
    throw new Error(
      `Agent '${agent.name}' is missing required role metadata. Run: hiboss agent set --name ${agent.name} --role <speaker|leader>`
    );
  }
  return role;
}

export function buildAgentStatusResult(params: {
  db: HiBossDatabase;
  executor: AgentExecutor;
  backgroundExecutor: BackgroundExecutor;
  agent: Agent;
}): AgentStatusResult {
  const { db, executor, backgroundExecutor, agent } = params;
  const effectiveProvider = agent.provider ?? DEFAULT_AGENT_PROVIDER;
  const effectivePermissionLevel = agent.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL;
  const effectiveWorkspace = agent.workspace ?? getDefaultRuntimeWorkspace();

  const isBusy = executor.isAgentBusy(agent.name);
  const pendingCount = db.countDuePendingEnvelopesForAgent(agent.name);
  const bindings = db.getBindingsByAgentName(agent.name).map((binding) => binding.adapterType);
  const currentRun = isBusy ? db.getCurrentRunningAgentRun(agent.name) : null;
  const lastRun = db.getLastFinishedAgentRun(agent.name);
  const background = backgroundExecutor.getSenderAgentSnapshot(agent.name);

  return {
    agent: {
      name: agent.name,
      role: requireAgentRole(agent),
      ...(agent.description ? { description: agent.description } : {}),
      ...(agent.workspace ? { workspace: agent.workspace } : {}),
      ...(agent.provider ? { provider: agent.provider } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
      ...(agent.permissionLevel ? { permissionLevel: agent.permissionLevel } : {}),
      ...(agent.sessionPolicy ? { sessionPolicy: agent.sessionPolicy } : {}),
    },
    bindings,
    effective: {
      workspace: effectiveWorkspace,
      provider: effectiveProvider,
      permissionLevel: effectivePermissionLevel,
    },
    status: {
      agentState: isBusy ? "running" : "idle",
      agentHealth: !lastRun ? "unknown" : lastRun.status === "failed" ? "error" : "ok",
      pendingCount,
      background,
      ...(currentRun
        ? {
            currentRun: {
              id: currentRun.id,
              startedAt: currentRun.startedAt,
            },
          }
        : {}),
      ...(lastRun
        ? {
            lastRun: {
              id: lastRun.id,
              startedAt: lastRun.startedAt,
              ...(typeof lastRun.completedAt === "number" ? { completedAt: lastRun.completedAt } : {}),
              status:
                lastRun.status === "failed"
                  ? "failed"
                  : lastRun.status === "cancelled"
                    ? "cancelled"
                    : "completed",
              ...(lastRun.error ? { error: lastRun.error } : {}),
              ...(typeof lastRun.contextLength === "number" ? { contextLength: lastRun.contextLength } : {}),
            },
          }
        : {}),
    },
  };
}
