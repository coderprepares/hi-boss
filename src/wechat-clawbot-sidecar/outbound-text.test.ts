import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWechatOutboundText } from "./outbound-text.js";

test("normalizes outbound WeChat line breaks to display separators", () => {
  assert.equal(
    normalizeWechatOutboundText("one\ntwo\r\nthree\rfour"),
    "one\u2028two\u2028three\u2028four"
  );
});
