import type { HiBossDatabase } from "./db/database.js";

const TELEGRAM_STATUS_MESSAGE_CONFIG_PREFIX = "telegram_status_message_enabled_";

function normalizeChatId(chatId: string): string {
  return chatId.trim();
}

export function getTelegramStatusMessageConfigKey(chatId: string): string {
  return `${TELEGRAM_STATUS_MESSAGE_CONFIG_PREFIX}${normalizeChatId(chatId)}`;
}

export function getTelegramStatusMessageEnabled(db: HiBossDatabase, chatId: string): boolean {
  const key = getTelegramStatusMessageConfigKey(chatId);
  const raw = db.getConfig(key);
  if (!raw) return true;
  return raw.trim() === "true";
}

export function setTelegramStatusMessageEnabled(db: HiBossDatabase, chatId: string, enabled: boolean): void {
  const key = getTelegramStatusMessageConfigKey(chatId);
  db.setConfig(key, enabled ? "true" : "false");
}
