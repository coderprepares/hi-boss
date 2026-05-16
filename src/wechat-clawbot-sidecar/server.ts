import * as http from "http";
import { timingSafeEqual } from "crypto";

import { WechatClawbotStateStore } from "./state.js";
import {
  SidecarHttpError,
  type IncomingWechatClawbotEvent,
  type WechatClawbotSidecarConfig,
  type WechatClawbotSidecarRuntimeOptions,
} from "./types.js";

const MAX_BODY_BYTES = 64 * 1024;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function equalToken(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new SidecarHttpError(413, "body-too-large", "request body too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SidecarHttpError(400, "invalid-json", "JSON object body is required");
  }
  return parsed as Record<string, unknown>;
}

function requireAuth(req: http.IncomingMessage, apiToken?: string): void {
  if (!apiToken) return;
  const header = req.headers.authorization ?? "";
  const expected = "Bearer ";
  if (!header.startsWith(expected) || !equalToken(header.slice(expected.length), apiToken)) {
    throw new SidecarHttpError(401, "unauthorized", "missing or invalid bearer token");
  }
}

function decodeParts(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function routeSendMessage(parts: string[]): { accountId: string; peerId: string } | undefined {
  if (parts.length !== 5) return undefined;
  if (parts[0] !== "accounts" || parts[2] !== "peers" || parts[4] !== "messages") return undefined;
  return { accountId: parts[1], peerId: parts[3] };
}

export class WechatClawbotSidecarServer {
  private server: http.Server;
  private store: WechatClawbotStateStore;

  constructor(
    private config: WechatClawbotSidecarConfig,
    private runtime: WechatClawbotSidecarRuntimeOptions = {}
  ) {
    this.store = new WechatClawbotStateStore(config.stateFile);
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => this.handleError(res, err));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  url(): string {
    const address = this.server.address();
    if (typeof address === "object" && address) {
      return `http://${address.address}:${address.port}`;
    }
    return `http://${this.config.host}:${this.config.port}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const parts = decodeParts(url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      json(res, 200, { ok: true, service: "wechat-clawbot-sidecar" });
      return;
    }

    requireAuth(req, this.runtime.apiToken);

    if (req.method === "GET" && url.pathname === "/accounts") {
      json(res, 200, { accounts: this.store.listAccounts() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/updates") {
      json(res, 200, this.store.getUpdates(url.searchParams.get("cursor") ?? undefined));
      return;
    }

    if (req.method === "POST" && url.pathname === "/__mock/events") {
      if (!this.config.mockIngestEnabled) {
        throw new SidecarHttpError(404, "not-found", "not found");
      }
      const body = await readJsonBody(req);
      const result = this.store.ingestEvent(body as IncomingWechatClawbotEvent, this.config.defaultAccount);
      json(res, result.duplicate ? 200 : 201, result);
      return;
    }

    const sendTarget = routeSendMessage(parts);
    if (req.method === "POST" && sendTarget) {
      const body = await readJsonBody(req);
      const text = typeof body.text === "string" ? body.text : "";
      const sent = this.store.sendText(sendTarget.accountId, sendTarget.peerId, text);
      json(res, 200, { ok: true, message_id: sent.id });
      return;
    }

    throw new SidecarHttpError(404, "not-found", "not found");
  }

  private handleError(res: http.ServerResponse, err: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof SidecarHttpError) {
      json(res, err.status, { ok: false, error: err.code, message: err.message });
      return;
    }
    json(res, 500, { ok: false, error: "internal-error", message: "internal sidecar error" });
  }
}
