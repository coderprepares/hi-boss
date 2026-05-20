import * as net from "net";
import type { JsonRpcRequest, JsonRpcResponse } from "../daemon/ipc/types.js";

export const DEFAULT_IPC_REQUEST_TIMEOUT_MS = 120000;

export interface IpcClientOptions {
  requestTimeoutMs?: number;
}

/**
 * IPC client for communicating with the Hi-Boss daemon.
 */
export class IpcClient {
  private requestId = 0;

  constructor(
    private socketPath: string,
    private options: IpcClientOptions = {}
  ) {}

  /**
   * Call an RPC method on the daemon.
   */
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method,
      params,
    };

    const response = await this.sendRequest(request);

    if (response.error) {
      const err = new Error(response.error.message) as Error & {
        code: number;
        data?: unknown;
      };
      err.code = response.error.code;
      err.data = response.error.data;
      throw err;
    }

    return response.result as T;
  }

  private sendRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const requestTimeoutMs = this.resolveRequestTimeoutMs();
      let buffer = "";
      let settled = false;

      const finish = (
        callback: () => void,
        close: "end" | "destroy" = "end"
      ) => {
        if (settled) return;
        settled = true;
        if (close === "destroy") socket.destroy();
        else socket.end();
        callback();
      };

      socket.on("connect", () => {
        socket.write(JSON.stringify(request) + "\n");
      });

      socket.on("data", (data) => {
        buffer += data.toString();

        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          try {
            const response = JSON.parse(line) as JsonRpcResponse;
            finish(() => resolve(response));
          } catch (err) {
            finish(() => reject(new Error("Invalid response from daemon")));
          }
        }
      });

      socket.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          finish(
            () => reject(new Error("Daemon is not running. Start it with: hiboss daemon start")),
            "destroy"
          );
        } else if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
          finish(() => reject(new Error("Cannot connect to daemon. Try restarting it.")), "destroy");
        } else {
          finish(() => reject(err), "destroy");
        }
      });

      socket.on("timeout", () => {
        finish(() => reject(new Error(`Request timed out after ${requestTimeoutMs}ms`)), "destroy");
      });

      socket.setTimeout(requestTimeoutMs);
    });
  }

  private resolveRequestTimeoutMs(): number {
    const value = this.options.requestTimeoutMs;
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : DEFAULT_IPC_REQUEST_TIMEOUT_MS;
  }
}
