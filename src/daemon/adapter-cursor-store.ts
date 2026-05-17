import { createHash } from "node:crypto";

import type { HiBossDatabase } from "./db/database.js";

const ADAPTER_CURSOR_CONFIG_PREFIX = "adapter_cursor_v1";

export function getAdapterCursorConfigKey(adapterType: string, adapterToken: string): string {
  const digest = createHash("sha256").update(adapterToken).digest("hex").slice(0, 24);
  return `${ADAPTER_CURSOR_CONFIG_PREFIX}:${adapterType}:${digest}`;
}

export function createAdapterCursorStore(
  db: HiBossDatabase,
  adapterType: string,
  adapterToken: string
): { load(): string | null; save(cursor: string): void } {
  const key = getAdapterCursorConfigKey(adapterType, adapterToken);
  return {
    load: () => db.getConfig(key),
    save: (cursor) => db.setConfig(key, cursor),
  };
}
