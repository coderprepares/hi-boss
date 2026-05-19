import assert from "node:assert/strict";
import test from "node:test";

import { buildCliEnvelopePromptContext } from "./prompt-context.js";
import type { Envelope } from "../envelope/types.js";

test("CLI envelope prompt context renders quoted attachments", () => {
  const envelope: Envelope = {
    id: "12345678-1234-4234-9234-123456789abc",
    from: "channel:wechat-clawbot:acct/wxid_boss",
    to: "agent:nex",
    fromBoss: true,
    content: { text: "reply text" },
    status: "pending",
    createdAt: Date.parse("2026-05-20T00:00:00.000Z"),
    metadata: {
      platform: "wechat-clawbot",
      channelMessageId: "evt-child",
      author: { id: "wxid_boss", displayName: "Boss" },
      chat: { id: "acct/wxid_boss" },
      inReplyTo: {
        text: "quoted text",
        attachments: [{ source: "/tmp/quoted-image.jpg", filename: "quoted-image.jpg" }],
      },
    },
  };

  const context = buildCliEnvelopePromptContext({
    envelope,
    bossTimezone: "UTC",
  }) as {
    envelope: {
      inReplyTo: {
        text: string;
        attachmentsText: string;
        attachments: Array<{ type: string; filename: string; source: string; displayName: string }>;
      };
    };
  };

  assert.equal(context.envelope.inReplyTo.text, "quoted text");
  assert.equal(context.envelope.inReplyTo.attachmentsText, "- [image] quoted-image.jpg (/tmp/quoted-image.jpg)");
  assert.deepEqual(context.envelope.inReplyTo.attachments, [{
    type: "image",
    source: "/tmp/quoted-image.jpg",
    filename: "quoted-image.jpg",
    displayName: "quoted-image.jpg",
  }]);
});
