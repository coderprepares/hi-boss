import { strict as assert } from "node:assert";
import test from "node:test";
import type { Agent } from "../agent/types.js";
import type { BackgroundSenderAgentSnapshot } from "../agent/background-executor.js";
import { createChannelCommandHandler } from "./channel-commands.js";

function makeAgent(name: string, role: "speaker" | "leader"): Agent {
  return {
    name,
    token: `${name}-token`,
    workspace: "/workspace",
    provider: "codex",
    createdAt: 0,
    metadata: { role },
  };
}

test("telegram /new can target a named agent", async () => {
  const agents = new Map([
    ["nex", makeAgent("nex", "speaker")],
    ["kai", makeAgent("kai", "leader")],
  ]);
  const requested: Array<{ agentName: string; reason: string }> = [];
  const handler = createChannelCommandHandler({
    db: {
      getAgentByNameCaseInsensitive(name: string) {
        return agents.get(name.toLowerCase()) ?? null;
      },
    } as any,
    executor: {
      requestSessionRefresh(agentName: string, reason: string) {
        requested.push({ agentName, reason });
      },
    } as any,
    backgroundExecutor: {} as any,
  });

  const result = await handler({
    command: "new",
    args: "kai",
    chatId: "1",
    authorUsername: "boss",
    agentName: "nex",
  } as any);

  assert.deepEqual(result, { text: "Session refresh requested.\nagent-name: kai" });
  assert.deepEqual(requested, [{ agentName: "kai", reason: "telegram:/new" }]);
});

test("channel /new reason uses command platform when provided", async () => {
  const agents = new Map([
    ["nex", makeAgent("nex", "speaker")],
  ]);
  const requested: Array<{ agentName: string; reason: string }> = [];
  const handler = createChannelCommandHandler({
    db: {
      getAgentByNameCaseInsensitive(name: string) {
        return agents.get(name.toLowerCase()) ?? null;
      },
    } as any,
    executor: {
      requestSessionRefresh(agentName: string, reason: string) {
        requested.push({ agentName, reason });
      },
    } as any,
    backgroundExecutor: {} as any,
  });

  await handler({
    platform: "wechat-clawbot",
    command: "new",
    args: "",
    chatId: "acct/wxid_boss",
    authorId: "wxid_boss",
    agentName: "nex",
  } as any);

  assert.deepEqual(requested, [{ agentName: "nex", reason: "wechat-clawbot:/new" }]);
});

test("channel /help reports commands for the current platform", async () => {
  const handler = createChannelCommandHandler({
    db: {} as any,
    executor: {} as any,
    backgroundExecutor: {} as any,
  });

  const wechat = await handler({
    platform: "wechat-clawbot",
    command: "help",
    args: "",
    chatId: "acct/wxid_boss",
    authorId: "wxid_boss",
    agentName: "nex",
  } as any);
  const telegram = await handler({
    platform: "telegram",
    command: "help",
    args: "",
    chatId: "1",
    authorUsername: "boss",
    agentName: "nex",
  } as any);

  assert.match(wechat?.text ?? "", /\/new \[agent-name\]/);
  assert.match(wechat?.text ?? "", /\/abort \[agent-name\]/);
  assert.doesNotMatch(wechat?.text ?? "", /\/verbose/);
  assert.match(telegram?.text ?? "", /\/verbose on\|off/);
});

test("telegram /abort can target a named agent", async () => {
  const agents = new Map([
    ["nex", makeAgent("nex", "speaker")],
    ["kai", makeAgent("kai", "leader")],
  ]);
  const aborted: Array<{ agentName: string; reason: string }> = [];
  const cleared: string[] = [];
  const handler = createChannelCommandHandler({
    db: {
      getAgentByNameCaseInsensitive(name: string) {
        return agents.get(name.toLowerCase()) ?? null;
      },
      markDuePendingNonCronEnvelopesDoneForAgent(agentName: string) {
        cleared.push(agentName);
        return 2;
      },
    } as any,
    executor: {
      abortCurrentRun(agentName: string, reason: string) {
        aborted.push({ agentName, reason });
        return true;
      },
    } as any,
    backgroundExecutor: {} as any,
  });

  const result = await handler({
    command: "abort",
    args: "kai",
    chatId: "1",
    authorUsername: "boss",
    agentName: "nex",
  } as any);

  assert.deepEqual(result, {
    text: [
      "abort: ok",
      "agent-name: kai",
      "cancelled-run: true",
      "cleared-pending-count: 2",
    ].join("\n"),
  });
  assert.deepEqual(aborted, [{ agentName: "kai", reason: "telegram:/abort" }]);
  assert.deepEqual(cleared, ["kai"]);
});

test("wechat /abort without args targets the bound agent", async () => {
  const agents = new Map([
    ["nex", makeAgent("nex", "speaker")],
  ]);
  const aborted: Array<{ agentName: string; reason: string }> = [];
  const cleared: string[] = [];
  const handler = createChannelCommandHandler({
    db: {
      getAgentByNameCaseInsensitive(name: string) {
        return agents.get(name.toLowerCase()) ?? null;
      },
      markDuePendingNonCronEnvelopesDoneForAgent(agentName: string) {
        cleared.push(agentName);
        return 0;
      },
    } as any,
    executor: {
      abortCurrentRun(agentName: string, reason: string) {
        aborted.push({ agentName, reason });
        return false;
      },
    } as any,
    backgroundExecutor: {} as any,
  });

  const result = await handler({
    platform: "wechat-clawbot",
    command: "abort",
    args: "",
    chatId: "acct/wxid_boss",
    authorId: "wxid_boss",
    agentName: "nex",
  } as any);

  assert.deepEqual(result, {
    text: [
      "abort: ok",
      "agent-name: nex",
      "cancelled-run: false",
      "cleared-pending-count: 0",
    ].join("\n"),
  });
  assert.deepEqual(aborted, [{ agentName: "nex", reason: "wechat-clawbot:/abort" }]);
  assert.deepEqual(cleared, ["nex"]);
});

test("channel /abort reports missing target agent without side effects", async () => {
  const aborted: Array<{ agentName: string; reason: string }> = [];
  const cleared: string[] = [];
  const handler = createChannelCommandHandler({
    db: {
      getAgentByNameCaseInsensitive() {
        return null;
      },
      markDuePendingNonCronEnvelopesDoneForAgent(agentName: string) {
        cleared.push(agentName);
        return 1;
      },
    } as any,
    executor: {
      abortCurrentRun(agentName: string, reason: string) {
        aborted.push({ agentName, reason });
        return true;
      },
    } as any,
    backgroundExecutor: {} as any,
  });

  const result = await handler({
    command: "abort",
    args: "missing",
    chatId: "1",
    authorUsername: "boss",
    agentName: "nex",
  } as any);

  assert.deepEqual(result, { text: "error: Agent not found" });
  assert.deepEqual(aborted, []);
  assert.deepEqual(cleared, []);
});

test("telegram /status can target a named agent", async () => {
  const agents = new Map([
    ["nex", makeAgent("nex", "speaker")],
    ["kai", makeAgent("kai", "leader")],
  ]);
  const snapshot: BackgroundSenderAgentSnapshot = {
    state: "idle",
    queuedCount: 0,
    runningCount: 0,
    openCount: 0,
  };
  const handler = createChannelCommandHandler({
    db: {
      getAgentByNameCaseInsensitive(name: string) {
        return agents.get(name.toLowerCase()) ?? null;
      },
      countDuePendingEnvelopesForAgent() {
        return 0;
      },
      getBindingsByAgentName() {
        return [];
      },
      getCurrentRunningAgentRun() {
        return null;
      },
      getLastFinishedAgentRun() {
        return null;
      },
      getBossTimezone() {
        return "UTC";
      },
    } as any,
    executor: {
      isAgentBusy() {
        return false;
      },
    } as any,
    backgroundExecutor: {
      getSenderAgentSnapshot() {
        return snapshot;
      },
    } as any,
  });

  const result = await handler({
    command: "status",
    args: "kai",
    chatId: "1",
    authorUsername: "boss",
    agentName: "nex",
  } as any);

  assert.equal(result?.text?.includes("name: kai"), true);
  assert.equal(result?.text?.includes("role: leader"), true);
});
