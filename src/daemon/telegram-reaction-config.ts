import type { HiBossDatabase } from "./db/database.js";

const TELEGRAM_REACTION_CONFIG_PREFIX = "telegram_reaction_enabled_";

function normalizeChatId(chatId: string): string {
  return chatId.trim();
}

export function getTelegramReactionConfigKey(chatId: string): string {
  return `${TELEGRAM_REACTION_CONFIG_PREFIX}${normalizeChatId(chatId)}`;
}

export function getTelegramReactionEnabled(db: HiBossDatabase, chatId: string): boolean {
  const key = getTelegramReactionConfigKey(chatId);
  const raw = db.getConfig(key);
  if (!raw) return false;
  return raw.trim() === "true";
}

export function setTelegramReactionEnabled(db: HiBossDatabase, chatId: string, enabled: boolean): void {
  const key = getTelegramReactionConfigKey(chatId);
  db.setConfig(key, enabled ? "true" : "false");
}
