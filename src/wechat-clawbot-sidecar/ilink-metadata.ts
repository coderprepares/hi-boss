import * as crypto from "crypto";

export const WECHAT_ILINK_CHANNEL_VERSION = "2.4.3";
const WECHAT_ILINK_APP_ID = "bot";
const DEFAULT_BOT_AGENT = "OpenClaw";
const BOT_AGENT_MAX_LEN = 256;

export function buildWechatIlinkClientVersion(version: string = WECHAT_ILINK_CHANNEL_VERSION): number {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  const major = Number.isFinite(parts[0]) ? parts[0] : 0;
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
  const patch = Number.isFinite(parts[2]) ? parts[2] : 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

export function sanitizeWechatIlinkBotAgent(raw: string | undefined): string {
  if (!raw || typeof raw !== "string") return DEFAULT_BOT_AGENT;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_BOT_AGENT;

  const productRe = /^[A-Za-z0-9_.\-]{1,32}\/[A-Za-z0-9_.+\-]{1,32}$/;
  const commentCharRe = /^[\x20-\x27\x2A-\x7E]{1,64}$/;
  const rawTokens = trimmed.split(/\s+/);
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const token = rawTokens[i];
    if (token.startsWith("(") && !token.endsWith(")")) {
      let combined = token;
      while (i + 1 < rawTokens.length && !combined.endsWith(")")) {
        i += 1;
        combined += ` ${rawTokens[i]}`;
      }
      tokens.push(combined);
    } else {
      tokens.push(token);
    }
  }

  const accepted: string[] = [];
  let pendingProduct: string | null = null;
  for (const token of tokens) {
    if (token.startsWith("(") && token.endsWith(")")) {
      const inner = token.slice(1, -1);
      if (pendingProduct && commentCharRe.test(inner)) {
        accepted.push(`${pendingProduct} (${inner})`);
        pendingProduct = null;
      } else if (pendingProduct) {
        accepted.push(pendingProduct);
        pendingProduct = null;
      }
      continue;
    }
    if (pendingProduct) {
      accepted.push(pendingProduct);
      pendingProduct = null;
    }
    if (productRe.test(token)) pendingProduct = token;
  }
  if (pendingProduct) accepted.push(pendingProduct);
  if (accepted.length === 0) return DEFAULT_BOT_AGENT;

  const joined = accepted.join(" ");
  if (Buffer.byteLength(joined, "utf8") <= BOT_AGENT_MAX_LEN) return joined;

  const truncated: string[] = [];
  let length = 0;
  for (const token of accepted) {
    const add = (truncated.length === 0 ? 0 : 1) + Buffer.byteLength(token, "utf8");
    if (length + add > BOT_AGENT_MAX_LEN) break;
    truncated.push(token);
    length += add;
  }
  return truncated.length > 0 ? truncated.join(" ") : DEFAULT_BOT_AGENT;
}

export function buildWechatIlinkBaseInfo(): Record<string, string> {
  return {
    channel_version: WECHAT_ILINK_CHANNEL_VERSION,
    bot_agent: DEFAULT_BOT_AGENT,
  };
}

function randomWechatUin(): string {
  const value = String(crypto.randomBytes(4).readUInt32BE(0));
  return Buffer.from(value, "utf8").toString("base64");
}

export function buildWechatIlinkHeaders(options: {
  token?: string;
  xWechatUin?: string;
  includeContentType?: boolean;
} = {}): Headers {
  const headers = new Headers({
    "iLink-App-Id": WECHAT_ILINK_APP_ID,
    "iLink-App-ClientVersion": String(buildWechatIlinkClientVersion()),
  });
  if (options.includeContentType !== false) headers.set("Content-Type", "application/json");
  if (options.includeContentType !== false) headers.set("AuthorizationType", "ilink_bot_token");
  const token = options.token?.trim();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.includeContentType !== false) headers.set("X-WECHAT-UIN", options.xWechatUin?.trim() || randomWechatUin());
  return headers;
}
