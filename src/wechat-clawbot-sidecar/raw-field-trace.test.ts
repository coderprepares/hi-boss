import assert from "node:assert/strict";
import test from "node:test";

import { traceRawMessageFields } from "./raw-field-trace.js";

test("raw field trace recursively logs field paths without raw values", () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  (process.stdout.write as any) = (chunk: unknown, ...args: unknown[]) => {
    writes.push(String(chunk));
    const callback = args.find((arg): arg is () => void => typeof arg === "function");
    callback?.();
    return true;
  };

  try {
    traceRawMessageFields({
      messageIndex: 0,
      env: { HIBOSS_WECHAT_CLAWBOT_TRACE_RAW_FIELDS: "true" },
      message: {
        message_id: "current-message-id",
        context_token: "secret-context-token",
        item_list: [{
          type: 1,
          text_item: { text: "sensitive message body" },
          ref_msg: {
            message_item: {
              source_message_id: "quoted-message-id",
              from_user_id: "quoted-user",
              item_list: [{
                type: 1,
                text_item: { text: "quoted sensitive text" },
              }],
            },
          },
        }],
      },
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = writes.join("");
  assert.match(output, /event=wechat-clawbot-raw-message-fields/);
  assert.match(output, /item_list\[\]\.ref_msg\.message_item\.source_message_id/);
  assert.match(output, /item_list\[\]\.ref_msg\.message_item\.item_list\[\]\.text_item\.text/);
  assert.match(output, /item-list-shape/);
  assert.doesNotMatch(output, /current-message-id/);
  assert.doesNotMatch(output, /secret-context-token/);
  assert.doesNotMatch(output, /sensitive message body/);
  assert.doesNotMatch(output, /quoted-message-id/);
  assert.doesNotMatch(output, /quoted-user/);
  assert.doesNotMatch(output, /quoted sensitive text/);
});
