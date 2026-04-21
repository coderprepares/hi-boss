import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { URL } from "node:url";

import { formatAgentAddress, parseAddress } from "../adapters/types.js";
import type { HiBossDatabase } from "../daemon/db/database.js";
import type { MessageRouter } from "../daemon/router/message-router.js";
import { formatShortId } from "../shared/id-format.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import { renderHttpBridgePayload } from "./formatter.js";
import type { HttpBridgeConfig, HttpIngressConfig } from "./types.js";

const MAX_BODY_BYTES = 1024 * 1024;

export class HttpIngressBridge {
  private server: Server | null = null;
  private readonly bridgesByPath = new Map<string, HttpBridgeConfig>();

  constructor(
    private readonly db: HiBossDatabase,
    private readonly router: MessageRouter,
    private readonly config: HttpIngressConfig,
  ) {
    for (const bridge of config.bridges) {
      this.bridgesByPath.set(bridge.path, bridge);
    }
  }

  async start(): Promise<void> {
    if (this.server || this.config.bridges.length === 0) {
      return;
    }

    this.server = createServer(async (req, res) => {
      await this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once("error", reject);
      server.listen(this.config.port, this.config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    logEvent("info", "http-ingress-started", {
      host: this.config.host,
      port: this.config.port,
      "bridge-count": this.config.bridges.length,
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    logEvent("info", "http-ingress-stopped");
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const bridge = this.bridgesByPath.get(url.pathname);

    if (!bridge) {
      this.writeJson(res, 404, { error: "not-found" });
      return;
    }

    if (method !== "POST") {
      this.writeJson(res, 405, { error: "method-not-allowed" });
      return;
    }

    if (!this.isAuthorized(req, bridge)) {
      logEvent("warn", "http-ingress-unauthorized", {
        bridge: bridge.name,
        path: bridge.path,
      });
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid request body";
      const status = message === "Request body too large" ? 413 : 400;
      this.writeJson(res, status, { error: "invalid-body", message });
      return;
    }

    const receivedAt = new Date().toISOString();

    try {
      const rendered = renderHttpBridgePayload({
        bridge,
        body,
        request: {
          method,
          path: url.pathname,
          receivedAt,
        },
      });

      const envelope = await this.router.routeEnvelope({
        from: this.resolveFromAddress(bridge),
        to: this.resolveToAddress(bridge),
        content: {
          text: rendered.text,
        },
        metadata: this.buildEnvelopeMetadata(bridge, rendered.metadata),
      });

      logEvent("info", "http-ingress-delivered", {
        bridge: bridge.name,
        path: bridge.path,
        "envelope-id": envelope.id,
        to: envelope.to,
      });
      this.writeJson(res, 202, {
        ok: true,
        "envelope-id": formatShortId(envelope.id),
      });
    } catch (err) {
      logEvent("error", "http-ingress-delivery-failed", {
        bridge: bridge.name,
        path: bridge.path,
        error: errorMessage(err),
      });
      this.writeJson(res, 500, {
        error: "delivery-failed",
        message: errorMessage(err),
      });
    }
  }

  private isAuthorized(
    req: IncomingMessage,
    bridge: HttpBridgeConfig,
  ): boolean {
    const actual = req.headers[bridge.auth.header.toLowerCase()];
    if (typeof actual !== "string") {
      return false;
    }

    const expectedBuffer = Buffer.from(bridge.auth.secret);
    const actualBuffer = Buffer.from(actual);
    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }
    return timingSafeEqual(expectedBuffer, actualBuffer);
  }

  private resolveFromAddress(bridge: HttpBridgeConfig): string {
    const destination = parseAddress(bridge.target.to);
    if (destination.type === "channel") {
      return formatAgentAddress(bridge.target.senderAgent!);
    }
    return `channel:http:${bridge.name}`;
  }

  private resolveToAddress(bridge: HttpBridgeConfig): string {
    const destination = parseAddress(bridge.target.to);
    if (destination.type === "agent") {
      const agent =
        this.db.getAgentByNameCaseInsensitive(destination.agentName) ??
        (destination.agentName === "background" ? { name: "background" } : null);
      if (!agent) {
        throw new Error(`HTTP bridge target agent not found: ${destination.agentName}`);
      }
      return formatAgentAddress(agent.name);
    }
    return bridge.target.to;
  }

  private buildEnvelopeMetadata(
    bridge: HttpBridgeConfig,
    renderedMetadata: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...renderedMetadata,
      ...(bridge.target.parseMode ? { parseMode: bridge.target.parseMode } : {}),
    };
  }

  private writeJson(
    res: ServerResponse,
    status: number,
    payload: Record<string, unknown>,
  ): void {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(body);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    throw new Error("Request body must be valid JSON");
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}
