import { logEvent } from "../shared/daemon-log.js";

const RAW_FIELD_TRACE_ENV = "HIBOSS_WECHAT_CLAWBOT_TRACE_RAW_FIELDS";
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 3;
const MAX_OBJECT_KEYS = 80;
const MAX_FIELD_PATHS = 240;

type RawFieldShape = {
  kind: string;
  keys?: string[];
  fields?: Record<string, RawFieldShape>;
  length?: number;
  items?: RawFieldShape[];
  truncated?: boolean;
};

function boolEnv(value: string | undefined): boolean {
  if (!value) return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function sortedObjectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

function scalarKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function rawFieldShape(value: unknown, depth = 0): RawFieldShape {
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return { kind: "array", length: value.length, truncated: value.length > 0 };
    const sampled = value.slice(0, MAX_ARRAY_ITEMS);
    return {
      kind: "array",
      length: value.length,
      items: sampled.map((item) => rawFieldShape(item, depth + 1)),
      ...(value.length > sampled.length ? { truncated: true } : {}),
    };
  }

  if (!value || typeof value !== "object") return { kind: scalarKind(value) };

  const keys = sortedObjectKeys(value);
  if (depth >= MAX_DEPTH) {
    return { kind: "object", keys, truncated: keys.length > 0 };
  }

  const fields: Record<string, RawFieldShape> = {};
  for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
    fields[key] = rawFieldShape((value as Record<string, unknown>)[key], depth + 1);
  }

  return {
    kind: "object",
    keys,
    fields,
    ...(keys.length > MAX_OBJECT_KEYS ? { truncated: true } : {}),
  };
}

function collectFieldPaths(value: unknown, prefix: string, paths: string[], depth = 0): void {
  if (paths.length >= MAX_FIELD_PATHS) return;
  if (depth >= MAX_DEPTH) {
    if (prefix) paths.push(`${prefix}.*`);
    return;
  }

  if (Array.isArray(value)) {
    const nextPrefix = `${prefix}[]`;
    if (value.length === 0) {
      if (prefix) paths.push(nextPrefix);
      return;
    }
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) collectFieldPaths(item, nextPrefix, paths, depth + 1);
    return;
  }

  if (!value || typeof value !== "object") {
    if (prefix) paths.push(prefix);
    return;
  }

  for (const key of sortedObjectKeys(value).slice(0, MAX_OBJECT_KEYS)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    collectFieldPaths((value as Record<string, unknown>)[key], nextPrefix, paths, depth + 1);
    if (paths.length >= MAX_FIELD_PATHS) return;
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function traceRawMessageFields(params: {
  message: Record<string, unknown>;
  messageIndex: number;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!boolEnv(params.env?.[RAW_FIELD_TRACE_ENV])) return;

  const itemList = params.message.item_list ?? params.message.itemList;
  const fieldPaths: string[] = [];
  collectFieldPaths(params.message, "", fieldPaths);
  const itemFieldPaths: string[] = [];
  collectFieldPaths(itemList, "item_list", itemFieldPaths);

  logEvent("info", "wechat-clawbot-raw-message-fields", {
    "message-index": params.messageIndex,
    "message-keys": sortedObjectKeys(params.message),
    "field-path-count": uniqueSorted(fieldPaths).length,
    "field-paths": uniqueSorted(fieldPaths),
    "item-list-shape": rawFieldShape(itemList),
    "item-field-paths": uniqueSorted(itemFieldPaths),
    "trace-depth": MAX_DEPTH,
  });
}
