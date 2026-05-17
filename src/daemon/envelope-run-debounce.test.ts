import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunTrigger } from "../agent/executor-triggers.js";
import { EnvelopeRunDebouncer } from "./envelope-run-debounce.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envelopeTrigger(envelopeId: string): AgentRunTrigger {
  return {
    kind: "envelope",
    source: "channel",
    envelopeId,
  };
}

test("coalesces multiple envelope triggers for the same agent", async () => {
  const debouncer = new EnvelopeRunDebouncer(10);
  const runs: Array<{ agentName: string; trigger: AgentRunTrigger }> = [];

  debouncer.schedule("nex", envelopeTrigger("first"), (task) => runs.push(task));
  debouncer.schedule("nex", envelopeTrigger("second"), (task) => runs.push(task));

  await wait(25);

  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.agentName, "nex");
  assert.deepEqual(runs[0]?.trigger, envelopeTrigger("second"));
});

test("keeps independent timers per agent", async () => {
  const debouncer = new EnvelopeRunDebouncer(10);
  const runs: Array<{ agentName: string; trigger: AgentRunTrigger }> = [];

  debouncer.schedule("nex", envelopeTrigger("nex-1"), (task) => runs.push(task));
  debouncer.schedule("kai", envelopeTrigger("kai-1"), (task) => runs.push(task));

  await wait(25);

  assert.deepEqual(
    runs.map((run) => run.agentName).sort(),
    ["kai", "nex"]
  );
});

test("clear cancels pending envelope run triggers", async () => {
  const debouncer = new EnvelopeRunDebouncer(10);
  const runs: Array<{ agentName: string; trigger: AgentRunTrigger }> = [];

  debouncer.schedule("nex", envelopeTrigger("first"), (task) => runs.push(task));
  debouncer.clear();

  await wait(25);

  assert.equal(runs.length, 0);
});
