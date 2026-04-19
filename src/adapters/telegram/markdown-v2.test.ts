import assert from "node:assert/strict";
import test from "node:test";
import { formatTelegramTextForParseMode, toTelegramMarkdownV2 } from "./markdown-v2.js";

test("toTelegramMarkdownV2 escapes plain special characters", () => {
  assert.equal(toTelegramMarkdownV2("hello.world"), "hello\\.world");
  assert.equal(toTelegramMarkdownV2("1 + 2 = 3"), "1 \\+ 2 \\= 3");
});

test("toTelegramMarkdownV2 preserves fenced code blocks", () => {
  const input = "```ts\nconsole.log('hi')\n```";
  assert.equal(toTelegramMarkdownV2(input), input);
});

test("toTelegramMarkdownV2 preserves inline code", () => {
  const input = "use `foo.bar()` here";
  assert.equal(toTelegramMarkdownV2(input), input);
});

test("toTelegramMarkdownV2 converts bold markers", () => {
  assert.equal(toTelegramMarkdownV2("this is **bold** text"), "this is *bold* text");
});

test("formatTelegramTextForParseMode only formats markdownv2", () => {
  assert.equal(formatTelegramTextForParseMode("**bold**", "markdownv2"), "*bold*");
  assert.equal(formatTelegramTextForParseMode("**bold**", "plain"), "**bold**");
  assert.equal(formatTelegramTextForParseMode("**bold**", "html"), "**bold**");
});
