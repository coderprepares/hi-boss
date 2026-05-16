import assert from "node:assert/strict";
import test from "node:test";

import type { Agent } from "../agent/types.js";
import {
  getExecutionLanePromptContext,
  resolveExecutionLaneForChannel,
} from "./execution-lane.js";

function agent(name: string, executionLane: Record<string, unknown>): Agent {
  return {
    name,
    token: `${name}-token`,
    createdAt: 0,
    metadata: {
      role: "speaker",
      executionLane,
    },
  };
}

test("execution lane routing prefers the most specific channel route", () => {
  const agents = [
    agent("fallback-speaker", {
      id: "fallback",
      channelRoutes: [{ adapterType: "telegram", chatId: "chat-1" }],
    }),
    agent("peer-speaker", {
      id: "peer",
      defaultLeader: "kai",
      leaderPool: ["kai", "mika"],
      backgroundMaxConcurrent: 1,
      channelRoutes: [{ adapterType: "telegram", chatId: "chat-1", authorId: "user-1" }],
    }),
  ];

  const resolved = resolveExecutionLaneForChannel({
    agents,
    fallbackAgentName: "binding-speaker",
    identity: {
      adapterType: "telegram",
      adapterToken: "not-exposed",
      chatId: "chat-1",
      authorId: "user-1",
    },
  });

  assert.equal(resolved.agentName, "peer-speaker");
  assert.equal(resolved.source, "channel-route");
  assert.equal(resolved.lane?.id, "peer");
  assert.deepEqual(getExecutionLanePromptContext(agents[1].metadata), {
    id: "peer",
    defaultLeader: "kai",
    leaderPool: ["kai", "mika"],
    backgroundMaxConcurrent: 1,
    channelRoutes: [{ adapterType: "telegram", chatId: "chat-1", authorId: "user-1" }],
  });
});

test("execution lane routing falls back to adapter binding when no route matches", () => {
  const resolved = resolveExecutionLaneForChannel({
    agents: [
      agent("other-speaker", {
        id: "other",
        channelRoutes: [{ adapterType: "wechat-clawbot", accountId: "acct-a" }],
      }),
    ],
    fallbackAgentName: "binding-speaker",
    identity: {
      adapterType: "wechat-clawbot",
      adapterToken: "not-exposed",
      chatId: "acct-b/wxid_boss",
      authorId: "wxid_boss",
      accountId: "acct-b",
      peerId: "wxid_boss",
    },
  });

  assert.equal(resolved.agentName, "binding-speaker");
  assert.equal(resolved.source, "binding");
  assert.equal(resolved.lane, undefined);
});
