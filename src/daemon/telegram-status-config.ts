import type { HiBossDatabase } from "./db/database.js";

const TELEGRAM_VERBOSE_CONFIG_PREFIX = "telegram_verbose_enabled_";

function normalizeChatId(chatId: string): string {
  return chatId.trim();
}

export function getTelegramVerboseConfigKey(chatId: string): string {
  return `${TELEGRAM_VERBOSE_CONFIG_PREFIX}${normalizeChatId(chatId)}`;
}

export function getTelegramVerboseEnabled(db: HiBossDatabase, chatId: string): boolean {
  const key = getTelegramVerboseConfigKey(chatId);
  const raw = db.getConfig(key);
  if (!raw) return false;
  return raw.trim() === "true";
}

export function setTelegramVerboseEnabled(db: HiBossDatabase, chatId: string, enabled: boolean): void {
  const key = getTelegramVerboseConfigKey(chatId);
  db.setConfig(key, enabled ? "true" : "false");
}
