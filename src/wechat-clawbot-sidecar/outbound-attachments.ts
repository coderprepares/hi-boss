import * as fs from "fs";
import * as path from "path";

import type { UploadedWechatMedia } from "./media.js";
import type { StoredWechatClawbotAttachment } from "./types.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
const MAX_REMOTE_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const CONTENT_TYPE_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/bmp", ".bmp"],
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
  ["application/pdf", ".pdf"],
]);

export interface OutboundAttachmentData {
  plaintext: Buffer;
  filename: string;
}

export type UploadedWechatAttachment = UploadedWechatMedia & {
  filename: string;
  kind: "image" | "video" | "file";
};

export function detectOutboundKind(attachment: Pick<StoredWechatClawbotAttachment, "source" | "filename">): "image" | "video" | "file" {
  const ext = path.extname(attachment.filename ?? attachment.source).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return VIDEO_EXTENSIONS.has(ext) ? "video" : "file";
}

function safeOutboundFilename(raw: string | undefined, fallback: string): string {
  const base = path.basename(raw ?? fallback).replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return base && base !== "." && base !== ".." ? base : fallback;
}

function contentTypeExtension(raw: string | null): string {
  const normalized = raw?.split(";")[0]?.trim().toLowerCase() ?? "";
  return CONTENT_TYPE_EXTENSIONS.get(normalized) ?? "";
}

function remoteUrlFilename(attachment: StoredWechatClawbotAttachment, url: URL, contentType: string | null): string {
  const ext = contentTypeExtension(contentType);
  const fallback = `wechat-remote${ext || ".bin"}`;
  const explicit = attachment.filename?.trim();
  const fromUrl = (() => {
    const basename = path.posix.basename(url.pathname);
    if (!basename || basename === "." || basename === "/") return undefined;
    try {
      return decodeURIComponent(basename);
    } catch {
      return basename;
    }
  })();
  const filename = safeOutboundFilename(explicit || fromUrl, fallback);
  return !path.extname(filename) && ext ? `${filename}${ext}` : filename;
}

function remoteAttachmentUrl(source: string): URL | undefined {
  if (!/^https?:\/\//i.test(source)) return undefined;
  return new URL(source);
}

export async function readOutboundAttachment(
  attachment: StoredWechatClawbotAttachment,
  options: { fetchImpl: FetchLike; requestTimeoutMs: number }
): Promise<OutboundAttachmentData> {
  const url = remoteAttachmentUrl(attachment.source);
  if (!url) {
    return {
      plaintext: fs.readFileSync(attachment.source),
      filename: safeOutboundFilename(attachment.filename, path.basename(attachment.source)),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  try {
    const response = await options.fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!response.ok) throw new Error(`wechat remote attachment HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(length) && length > MAX_REMOTE_ATTACHMENT_BYTES) {
      throw new Error("wechat remote attachment too large");
    }
    const plaintext = Buffer.from(await response.arrayBuffer());
    if (plaintext.length > MAX_REMOTE_ATTACHMENT_BYTES) {
      throw new Error("wechat remote attachment too large");
    }
    return {
      plaintext,
      filename: remoteUrlFilename(attachment, url, response.headers.get("content-type")),
    };
  } finally {
    clearTimeout(timeout);
  }
}
