import type { HiBossDatabase } from "./db/database.js";

const TELEGRAM_QUEUE_MODE_CONFIG_PREFIX = "telegram_queue_mode_enabled_";

function normalizeAgentName(agentName: string): string {
  return agentName.trim().toLowerCase();
}

export function getTelegramQueueModeConfigKey(agentName: string): string {
  return `${TELEGRAM_QUEUE_MODE_CONFIG_PREFIX}${normalizeAgentName(agentName)}`;
}

export function getTelegramQueueModeEnabled(db: HiBossDatabase, agentName: string): boolean {
  const key = getTelegramQueueModeConfigKey(agentName);
  const raw = db.getConfig(key);
  if (!raw) return true;
  return raw.trim() === "true";
}

export function setTelegramQueueModeEnabled(db: HiBossDatabase, agentName: string, enabled: boolean): void {
  const key = getTelegramQueueModeConfigKey(agentName);
  db.setConfig(key, enabled ? "true" : "false");
}
