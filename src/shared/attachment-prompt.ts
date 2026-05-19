import * as path from "path";

import { detectAttachmentType } from "../adapters/types.js";
import type { EnvelopeAttachment } from "../envelope/types.js";

export interface AttachmentPrompt {
  type: "image" | "video" | "audio" | "file";
  source: string;
  filename: string;
  displayName: string;
}

function displayAttachmentName(att: { source: string; filename?: string }): string | undefined {
  if (att.filename) return att.filename;

  try {
    const url = new URL(att.source);
    const base = path.posix.basename(url.pathname);
    return base || undefined;
  } catch {
    // Not a URL; treat as a local path.
  }

  return path.basename(att.source) || undefined;
}

export function buildAttachmentPrompts(attachments: EnvelopeAttachment[] | undefined): AttachmentPrompt[] {
  return (attachments ?? []).map((att) => {
    const type = detectAttachmentType(att);
    const displayName = displayAttachmentName(att) ?? "";
    return {
      type,
      source: att.source,
      filename: att.filename ?? "",
      displayName,
    };
  });
}

export function formatAttachmentsText(attachments: EnvelopeAttachment[] | undefined): string {
  if (!attachments?.length) return "(none)";

  return attachments
    .map((att) => {
      const type = detectAttachmentType(att);
      const displayName = displayAttachmentName(att);
      if (!displayName || displayName === att.source) {
        return `- [${type}] ${att.source}`;
      }
      return `- [${type}] ${displayName} (${att.source})`;
    })
    .join("\n");
}
