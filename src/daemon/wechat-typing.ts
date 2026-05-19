import type { ChatAdapter } from "../adapters/types.js";
import { parseAddress } from "../adapters/types.js";
import type { AgentRunStatusReporter } from "../agent/executor.js";
import type { RuntimeEvent } from "../agent/executor-turn.js";
import type { Agent } from "../agent/types.js";
import type { Envelope } from "../envelope/types.js";
import type { HiBossDatabase } from "./db/database.js";

function getSingleWechatChatId(envelopes: Envelope[]): string | null {
  let chatId: string | null = null;

  for (const envelope of envelopes) {
    let from: ReturnType<typeof parseAddress>;
    try {
      from = parseAddress(envelope.from);
    } catch {
      return null;
    }

    if (from.type !== "channel" || from.adapter !== "wechat-clawbot") {
      return null;
    }

    if (chatId === null) {
      chatId = from.chatId;
    } else if (chatId !== from.chatId) {
      return null;
    }
  }

  return chatId;
}

export function createWechatTypingRunStatusReporter(params: {
  db: HiBossDatabase;
  adapters: Map<string, ChatAdapter>;
  agent: Agent;
  envelopes: Envelope[];
}): AgentRunStatusReporter | undefined {
  const chatId = getSingleWechatChatId(params.envelopes);
  if (!chatId) return undefined;

  const binding = params.db.getAgentBindingByType(params.agent.name, "wechat-clawbot");
  if (!binding) return undefined;

  const adapter = params.adapters.get(binding.adapterToken);
  const typingIndicator = adapter?.createTypingIndicator?.(chatId);
  if (!typingIndicator) return undefined;

  return {
    onEvent: (event: RuntimeEvent) => {
      if (event.type === "turn.started") {
        typingIndicator.start();
        return;
      }
      if (event.type === "turn.completed") {
        typingIndicator.stop();
      }
    },
    finish: () => {
      typingIndicator.stop();
    },
  };
}
