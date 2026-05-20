import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWechatOutboundText } from "./outbound-text.js";

test("normalizes outbound WeChat line breaks to plain LF", () => {
  assert.equal(
    normalizeWechatOutboundText("one\ntwo\r\nthree\rfour"),
    "one\ntwo\nthree\nfour"
  );
});
