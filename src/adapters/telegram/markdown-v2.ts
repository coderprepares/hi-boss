import type { OutgoingParseMode } from "../types.js";

/**
 * Convert common markdown-ish text into Telegram MarkdownV2-safe text.
 *
 * This keeps fenced code blocks and inline code intact, converts `**bold**`
 * into Telegram's `*bold*`, and escapes Telegram MarkdownV2 special chars
 * in normal text.
 */
export function toTelegramMarkdownV2(input: string): string {
  let result = "";
  let i = 0;

  while (i < input.length) {
    if (input.startsWith("```", i)) {
      const closing = input.indexOf("```", i + 3);
      if (closing === -1) {
        result += input.slice(i);
        break;
      }
      result += input.slice(i, closing + 3);
      i = closing + 3;
      continue;
    }

    if (input[i] === "`") {
      const closing = input.indexOf("`", i + 1);
      if (closing === -1) {
        result += input.slice(i);
        break;
      }
      result += input.slice(i, closing + 1);
      i = closing + 1;
      continue;
    }

    if (input.startsWith("**", i)) {
      const closing = input.indexOf("**", i + 2);
      if (closing === -1) {
        result += "\\*\\*";
        i += 2;
        continue;
      }

      result += "*";
      const inner = input.slice(i + 2, closing);
      for (const ch of inner) {
        if (isTelegramMarkdownV2Special(ch) && ch !== "*") {
          result += "\\";
        }
        result += ch;
      }
      result += "*";
      i = closing + 2;
      continue;
    }

    const ch = input[i]!;
    if (isTelegramMarkdownV2Special(ch)) {
      result += "\\";
    }
    result += ch;
    i += 1;
  }

  return result;
}

export function formatTelegramTextForParseMode(text: string, mode: OutgoingParseMode | undefined): string {
  if (mode === "markdownv2") {
    return toTelegramMarkdownV2(text);
  }
  return text;
}

function isTelegramMarkdownV2Special(ch: string): boolean {
  return "_*[]()~`>#+-=|{}.!".includes(ch);
}
