import assert from "assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";
import { sendTelegramMessage } from "./outgoing.js";

function makeTempFile(filename: string): { filePath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-"));
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, "hello", "utf8");
  return {
    filePath,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Telegram outgoing local document upload includes filename (defaults to basename)", async () => {
  const { filePath, cleanup } = makeTempFile("foo.txt");
  let capturedSource: unknown = undefined;

  try {
    await sendTelegramMessage(
      {
        sendMessage: async () => {
          throw new Error("unexpected sendMessage");
        },
        sendPhoto: async () => {
          throw new Error("unexpected sendPhoto");
        },
        sendVideo: async () => {
          throw new Error("unexpected sendVideo");
        },
        sendAudio: async () => {
          throw new Error("unexpected sendAudio");
        },
        sendDocument: async (_chatId, source) => {
          capturedSource = source;
        },
        callApi: async () => {
          throw new Error("unexpected callApi");
        },
      },
      "123",
      {
        attachments: [{ source: filePath }],
      }
    );

    assert.ok(capturedSource && typeof capturedSource === "object");
    assert.equal((capturedSource as { filename?: string }).filename, "foo.txt");
    assert.equal((capturedSource as { source?: string }).source, path.resolve(filePath));
  } finally {
    cleanup();
  }
});

test("Telegram outgoing local document upload respects attachment.filename", async () => {
  const { filePath, cleanup } = makeTempFile("foo.txt");
  let capturedSource: unknown = undefined;

  try {
    await sendTelegramMessage(
      {
        sendMessage: async () => {
          throw new Error("unexpected sendMessage");
        },
        sendPhoto: async () => {
          throw new Error("unexpected sendPhoto");
        },
        sendVideo: async () => {
          throw new Error("unexpected sendVideo");
        },
        sendAudio: async () => {
          throw new Error("unexpected sendAudio");
        },
        sendDocument: async (_chatId, source) => {
          capturedSource = source;
        },
        callApi: async () => {
          throw new Error("unexpected callApi");
        },
      },
      "123",
      {
        attachments: [{ source: filePath, filename: "report.md" }],
      }
    );

    assert.ok(capturedSource && typeof capturedSource === "object");
    assert.equal((capturedSource as { filename?: string }).filename, "report.md");
    assert.equal((capturedSource as { source?: string }).source, path.resolve(filePath));
  } finally {
    cleanup();
  }
});

test("Telegram outgoing local media group includes filename for each document", async () => {
  const a = makeTempFile("a.txt");
  const b = makeTempFile("b.md");
  let capturedPayload: unknown = undefined;

  try {
    await sendTelegramMessage(
      {
        sendMessage: async () => {
          throw new Error("unexpected sendMessage");
        },
        sendPhoto: async () => {
          throw new Error("unexpected sendPhoto");
        },
        sendVideo: async () => {
          throw new Error("unexpected sendVideo");
        },
        sendAudio: async () => {
          throw new Error("unexpected sendAudio");
        },
        sendDocument: async () => {
          throw new Error("unexpected sendDocument");
        },
        callApi: async (method, payload) => {
          assert.equal(method, "sendMediaGroup");
          capturedPayload = payload;
        },
      },
      "123",
      {
        attachments: [
          { source: a.filePath },
          { source: b.filePath, filename: "custom.bin" },
        ],
      }
    );

    assert.ok(capturedPayload && typeof capturedPayload === "object");
    const media = (capturedPayload as { media?: unknown }).media as Array<{ media: unknown }>;
    assert.equal(media.length, 2);
    assert.equal((media[0].media as { filename?: string }).filename, "a.txt");
    assert.equal((media[1].media as { filename?: string }).filename, "custom.bin");
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("Telegram outgoing markdownv2 text is converted before send", async () => {
  let capturedText = "";
  let capturedExtra: unknown = undefined;

  await sendTelegramMessage(
    {
      sendMessage: async (_chatId, text, extra) => {
        capturedText = text;
        capturedExtra = extra;
      },
      sendPhoto: async () => {
        throw new Error("unexpected sendPhoto");
      },
      sendVideo: async () => {
        throw new Error("unexpected sendVideo");
      },
      sendAudio: async () => {
        throw new Error("unexpected sendAudio");
      },
      sendDocument: async () => {
        throw new Error("unexpected sendDocument");
      },
      callApi: async () => {
        throw new Error("unexpected callApi");
      },
    },
    "123",
    { text: "能看到 **加粗** 和 `code()`." },
    { parseMode: "markdownv2" }
  );

  assert.equal(capturedText, "能看到 *加粗* 和 `code()`\\.");
  assert.equal((capturedExtra as { parse_mode?: string }).parse_mode, "MarkdownV2");
});
