import assert from "node:assert/strict";
import test from "node:test";
import type { AgentStatusResult } from "../daemon/ipc/types.js";
import { renderAgentStatusText } from "./agent-status-output.js";

test("renderAgentStatusText includes background delegation fields", () => {
  const result: AgentStatusResult = {
    agent: {
      name: "nex",
      role: "leader",
    },
    bindings: [],
    effective: {
      workspace: "/tmp/workspace",
      provider: "codex",
      permissionLevel: "restricted",
    },
    status: {
      agentState: "idle",
      agentHealth: "ok",
      pendingCount: 0,
      background: {
        state: "active",
        queuedCount: 2,
        runningCount: 1,
        openCount: 3,
      },
    },
  };

  assert.deepEqual(renderAgentStatusText(result, "UTC").split("\n"), [
    "name: nex",
    "role: leader",
    "workspace: /tmp/workspace",
    "provider: codex",
    "model: default",
    "reasoning-effort: default",
    "permission-level: restricted",
    "bindings: (none)",
    "agent-state: idle",
    "agent-health: ok",
    "pending-count: 0",
    "background-state: active",
    "background-running-count: 1",
    "background-queued-count: 2",
    "background-open-count: 3",
    "last-run-status: none",
  ]);
});
