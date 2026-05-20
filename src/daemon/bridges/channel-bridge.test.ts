import assert from "node:assert/strict";
import test from "node:test";

import type {
  ChannelCommand,
  ChannelCommandHandler,
  ChannelMessage,
  ChannelMessageHandler,
  ChatAdapter,
  MessageContent,
} from "../../adapters/types.js";
import type { CreateEnvelopeInput } from "../../envelope/types.js";
import { ChannelBridge } from "./channel-bridge.js";

class FakeAdapter implements ChatAdapter {
  readonly platform = "wechat-clawbot";
  messageHandler?: ChannelMessageHandler;
  commandHandler?: ChannelCommandHandler;

  async sendMessage(_chatId: string, _content: MessageContent): Promise<void> {}

  onMessage(handler: ChannelMessageHandler): void {
    this.messageHandler = handler;
  }

  onCommand(handler: ChannelCommandHandler): void {
    this.commandHandler = handler;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}

test("channel bridge routes matching channel identities to execution lane speaker", async () => {
  const routed: CreateEnvelopeInput[] = [];
  const adapter = new FakeAdapter();
  const bridge = new ChannelBridge(
    {
      registerAdapter() {},
      routeEnvelope(input: CreateEnvelopeInput) {
        routed.push(input);
      },
    } as any,
    {
      getAdapterBossId() {
        return "wxid_boss";
      },
      getBindingByAdapter() {
        return { agentName: "default-speaker" };
      },
      listAgents() {
        return [
          {
            name: "lane-speaker",
            token: "lane-token",
            createdAt: 0,
            metadata: {
              role: "speaker",
              executionLane: {
                id: "wechat-account-a",
                defaultLeader: "kai-a",
                leaderPool: ["kai-a", "kai-b"],
                backgroundMaxConcurrent: 1,
                channelRoutes: [
                  { adapterType: "wechat-clawbot", accountId: "acct-a", peerId: "wxid_boss" },
                ],
              },
            },
          },
        ];
      },
    } as any,
    {} as any
  );

  bridge.connect(adapter, "sidecar-token");

  const message: ChannelMessage = {
    id: "evt-1",
    platform: "wechat-clawbot",
    author: { id: "wxid_boss", displayName: "Boss" },
    chat: { id: "acct-a/wxid_boss", name: "Boss" },
    content: { text: "hello" },
    raw: {},
  };

  await adapter.messageHandler?.(message);

  assert.equal(routed.length, 1);
  assert.equal(routed[0].from, "channel:wechat-clawbot:acct-a/wxid_boss");
  assert.equal(routed[0].to, "agent:lane-speaker");
  assert.equal(routed[0].fromBoss, true);
  assert.deepEqual(routed[0].metadata?.executionLane, {
    id: "wechat-account-a",
    source: "channel-route",
    speakerAgent: "lane-speaker",
    defaultLeader: "kai-a",
    leaderPool: ["kai-a", "kai-b"],
    backgroundMaxConcurrent: 1,
  });
});

test("channel bridge resolves channel commands through execution lanes", async () => {
  const adapter = new FakeAdapter();
  const seenCommands: Array<ChannelCommand & { agentName?: string }> = [];
  const bridge = new ChannelBridge(
    {
      registerAdapter() {},
      routeEnvelope() {},
    } as any,
    {
      getAdapterBossId() {
        return "wxid_boss";
      },
      getBindingByAdapter() {
        return { agentName: "default-speaker" };
      },
      listAgents() {
        return [
          {
            name: "lane-speaker",
            token: "lane-token",
            createdAt: 0,
            metadata: {
              role: "speaker",
              executionLane: {
                id: "wechat-account-a",
                channelRoutes: [
                  { adapterType: "wechat-clawbot", accountId: "acct-a", peerId: "wxid_boss" },
                ],
              },
            },
          },
        ];
      },
    } as any,
    {} as any
  );

  bridge.setCommandHandler((command) => {
    seenCommands.push(command as ChannelCommand & { agentName?: string });
    return { text: "ok" };
  });
  bridge.connect(adapter, "sidecar-token");

  const response = await adapter.commandHandler?.({
    platform: "wechat-clawbot",
    command: "status",
    args: "",
    chatId: "acct-a/wxid_boss",
    authorId: "wxid_boss",
  });

  assert.deepEqual(response, { text: "ok" });
  assert.equal(seenCommands.length, 1);
  assert.equal(seenCommands[0].agentName, "lane-speaker");
});
