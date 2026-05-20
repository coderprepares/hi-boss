import assert from "node:assert/strict";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import test from "node:test";

import { DEFAULT_IPC_REQUEST_TIMEOUT_MS, IpcClient } from "./ipc-client.js";

async function withServer(
  handler: (socket: net.Socket) => void | Promise<void>,
  run: (socketPath: string) => Promise<void>
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-ipc-client-"));
  const socketPath = path.join(dir, "daemon.sock");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void handler(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    await run(socketPath);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("IPC client waits long enough for slow daemon responses", async () => {
  await withServer((socket) => {
    socket.once("data", () => {
      setTimeout(() => {
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n");
      }, 40);
    });
  }, async (socketPath) => {
    const client = new IpcClient(socketPath, { requestTimeoutMs: 200 });
    const result = await client.call("daemon.ping");

    assert.deepEqual(result, { ok: true });
  });
});

test("IPC client reports configured timeout duration", async () => {
  await withServer(() => undefined, async (socketPath) => {
    const client = new IpcClient(socketPath, { requestTimeoutMs: 10 });

    await assert.rejects(
      () => client.call("daemon.ping"),
      /Request timed out after 10ms/
    );
  });
});

test("IPC client default timeout supports slow channel delivery", () => {
  assert.equal(DEFAULT_IPC_REQUEST_TIMEOUT_MS, 120000);
});
