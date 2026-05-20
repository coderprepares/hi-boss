import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import type { FetchLike } from "./ilink-client.js";
import type { StoredWechatClawbotAttachment } from "./types.js";

export interface WechatCdnMediaRef {
  full_url?: string;
  aes_key?: string;
}

interface DownloadWechatMediaParams {
  media: WechatCdnMediaRef;
  mediaDir: string;
  filename: string;
  aesKey?: string;
  fetchImpl: FetchLike;
  requestTimeoutMs: number;
}

interface UploadWechatMediaParams {
  plaintext: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
  fetchImpl: FetchLike;
  requestTimeoutMs: number;
}

export interface UploadedWechatMedia {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskeyHex: string;
  rawSize: number;
  ciphertextSize: number;
  md5: string;
}

function decodeAesKey(raw: string | undefined): Buffer | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  if (/^[0-9a-f]{32}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 16) return decoded;
  const decodedText = decoded.toString("utf8");
  return /^[0-9a-f]{32}$/i.test(decodedText) ? Buffer.from(decodedText, "hex") : undefined;
}

function decryptAes128Ecb(payload: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

export function encryptAes128Ecb(payload: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(payload), cipher.final()]);
}

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function md5Hex(payload: Buffer): string {
  return crypto.createHash("md5").update(payload).digest("hex");
}

export function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function safeFilename(raw: string, fallback: string): string {
  const base = path.basename(raw || fallback).replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return base && base !== "." && base !== ".." ? base : fallback;
}

function uniquePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

export function defaultWechatMediaFilename(params: {
  messageId: string;
  itemIndex: number;
  kind: "image" | "video" | "file" | "voice";
  filename?: string;
}): string {
  const fallback = params.kind === "image"
    ? `wechat-image-${params.messageId}-${params.itemIndex}.jpg`
    : params.kind === "video"
      ? `wechat-video-${params.messageId}-${params.itemIndex}.mp4`
    : params.kind === "voice"
      ? `wechat-voice-${params.messageId}-${params.itemIndex}.silk`
    : `wechat-file-${params.messageId}-${params.itemIndex}.bin`;
  return safeFilename(params.filename ?? fallback, fallback);
}

export async function downloadWechatCdnMedia(
  params: DownloadWechatMediaParams
): Promise<StoredWechatClawbotAttachment | undefined> {
  const url = params.media.full_url?.trim();
  const key = decodeAesKey(params.aesKey ?? params.media.aes_key);
  if (!url || !key) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.requestTimeoutMs);
  try {
    const response = await params.fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!response.ok) return undefined;
    const encrypted = Buffer.from(await response.arrayBuffer());
    const decrypted = decryptAes128Ecb(encrypted, key);
    fs.mkdirSync(params.mediaDir, { recursive: true, mode: 0o700 });
    const filename = safeFilename(params.filename, "wechat-media.bin");
    const target = uniquePath(params.mediaDir, filename);
    fs.writeFileSync(target, decrypted, { mode: 0o600 });
    return { source: target, filename };
  } finally {
    clearTimeout(timeout);
  }
}

function buildCdnUploadUrl(params: { cdnBaseUrl: string; uploadParam: string; filekey: string }): string {
  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}` +
    `&filekey=${encodeURIComponent(params.filekey)}`;
}

export async function uploadWechatCdnMedia(
  params: UploadWechatMediaParams
): Promise<{ downloadEncryptedQueryParam: string; ciphertextSize: number }> {
  const ciphertext = encryptAes128Ecb(params.plaintext, params.aeskey);
  const uploadUrl = params.uploadFullUrl?.trim() ||
    (params.uploadParam ? buildCdnUploadUrl({
      cdnBaseUrl: params.cdnBaseUrl,
      uploadParam: params.uploadParam,
      filekey: params.filekey,
    }) : undefined);
  if (!uploadUrl) throw new Error("wechat CDN upload URL missing");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.requestTimeoutMs);
  try {
    const response = await params.fetchImpl(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`wechat CDN upload HTTP ${response.status}`);
    const downloadEncryptedQueryParam = response.headers.get("x-encrypted-param")?.trim();
    if (!downloadEncryptedQueryParam) throw new Error("wechat CDN upload response missing x-encrypted-param");
    return { downloadEncryptedQueryParam, ciphertextSize: ciphertext.length };
  } finally {
    clearTimeout(timeout);
  }
}
