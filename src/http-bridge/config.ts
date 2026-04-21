import { parseAddress } from "../adapters/types.js";
import { BACKGROUND_AGENT_NAME } from "../shared/defaults.js";
import { isValidAgentName } from "../shared/validation.js";
import {
  DEFAULT_HTTP_INGRESS_HOST,
  DEFAULT_HTTP_INGRESS_PORT,
  HTTP_INGRESS_CONFIG_KEY,
  type HttpBridgeConfig,
  type HttpIngressConfig,
} from "./types.js";

const HEADER_NAME_REGEX = /^[A-Za-z0-9-]+$/;

export interface ValidateHttpIngressOptions {
  agentNames?: string[];
}

export function validateHttpIngressConfig(
  config: HttpIngressConfig,
  options: ValidateHttpIngressOptions = {},
): void {
  if (!config.host.trim()) {
    throw new Error("Invalid http-ingress config (host is required)");
  }

  if (
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535
  ) {
    throw new Error("Invalid http-ingress config (port must be an integer between 1 and 65535)");
  }

  if (!Array.isArray(config.bridges)) {
    throw new Error("Invalid http-ingress config (bridges must be an array)");
  }

  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  const agentNames = new Set(
    (options.agentNames ?? []).map((name) => name.trim().toLowerCase()),
  );

  for (const bridge of config.bridges) {
    validateBridge(bridge, seenNames, seenPaths, agentNames);
  }
}

export function parseStoredHttpIngressConfig(
  raw: string | null,
): HttpIngressConfig | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid stored ${HTTP_INGRESS_CONFIG_KEY} config (expected valid JSON)`,
    );
  }

  const config = normalizeHttpIngressConfig(parsed);
  validateHttpIngressConfig(config);
  return config;
}

export function serializeHttpIngressConfig(config: HttpIngressConfig): string {
  validateHttpIngressConfig(config);
  return JSON.stringify(config);
}

export function normalizeHttpIngressConfig(value: unknown): HttpIngressConfig {
  if (!isPlainObject(value)) {
    throw new Error("Invalid http-ingress config (expected object)");
  }

  if (value.host !== undefined && typeof value.host !== "string") {
    throw new Error("Invalid http-ingress config (host must be a string)");
  }
  if (value.port !== undefined && typeof value.port !== "number") {
    throw new Error("Invalid http-ingress config (port must be a number)");
  }

  const host =
    typeof value.host === "string" && value.host.trim()
      ? value.host.trim()
      : DEFAULT_HTTP_INGRESS_HOST;
  const port =
    typeof value.port === "number" && Number.isFinite(value.port)
      ? Math.trunc(value.port)
      : DEFAULT_HTTP_INGRESS_PORT;
  const bridgesRaw = value.bridges;
  if (bridgesRaw === undefined) {
    return {
      host,
      port,
      bridges: [],
    };
  }
  if (!Array.isArray(bridgesRaw)) {
    throw new Error("Invalid http-ingress config (bridges must be an array)");
  }

  return {
    host,
    port,
    bridges: bridgesRaw.map((item, index) => normalizeBridge(item, index)),
  };
}

function validateBridge(
  bridge: HttpBridgeConfig,
  seenNames: Set<string>,
  seenPaths: Set<string>,
  agentNames: Set<string>,
): void {
  if (!bridge.name.trim()) {
    throw new Error("Invalid http-ingress config (bridge.name is required)");
  }

  const nameKey = bridge.name.trim().toLowerCase();
  if (seenNames.has(nameKey)) {
    throw new Error(`Invalid http-ingress config (duplicate bridge name): ${bridge.name}`);
  }
  seenNames.add(nameKey);

  if (!bridge.path.startsWith("/")) {
    throw new Error(
      `Invalid http-ingress config (bridge.path for '${bridge.name}' must start with '/')`,
    );
  }
  if (bridge.path.includes("?") || bridge.path.includes("#")) {
    throw new Error(
      `Invalid http-ingress config (bridge.path for '${bridge.name}' must not include query or fragment)`,
    );
  }
  if (seenPaths.has(bridge.path)) {
    throw new Error(`Invalid http-ingress config (duplicate bridge path): ${bridge.path}`);
  }
  seenPaths.add(bridge.path);

  if (!HEADER_NAME_REGEX.test(bridge.auth.header)) {
    throw new Error(
      `Invalid http-ingress config (auth.header for '${bridge.name}' must be a valid header name)`,
    );
  }
  if (!bridge.auth.secret) {
    throw new Error(
      `Invalid http-ingress config (auth.secret for '${bridge.name}' is required)`,
    );
  }

  if (!bridge.formatter.text.trim()) {
    throw new Error(
      `Invalid http-ingress config (formatter.text for '${bridge.name}' is required)`,
    );
  }

  if (
    bridge.formatter.metadata !== undefined &&
    !isPlainObject(bridge.formatter.metadata)
  ) {
    throw new Error(
      `Invalid http-ingress config (formatter.metadata for '${bridge.name}' must be an object)`,
    );
  }

  const destination = parseAddress(bridge.target.to);
  if (destination.type === "channel") {
    if (!bridge.target.senderAgent) {
      throw new Error(
        `Invalid http-ingress config (target.sender-agent for '${bridge.name}' is required for channel destinations)`,
      );
    }
    if (!isValidAgentName(bridge.target.senderAgent)) {
      throw new Error(
        `Invalid http-ingress config (target.sender-agent for '${bridge.name}' must be a valid agent name)`,
      );
    }
    if (agentNames.size > 0 && !agentNames.has(bridge.target.senderAgent.toLowerCase())) {
      throw new Error(
        `Invalid http-ingress config (target.sender-agent for '${bridge.name}' must reference a configured agent)`,
      );
    }
  } else {
    if (bridge.target.senderAgent !== undefined) {
      throw new Error(
        `Invalid http-ingress config (target.sender-agent for '${bridge.name}' is only allowed for channel destinations)`,
      );
    }
    if (bridge.target.parseMode !== undefined) {
      throw new Error(
        `Invalid http-ingress config (target.parse-mode for '${bridge.name}' is only allowed for channel destinations)`,
      );
    }
    if (
      agentNames.size > 0 &&
      destination.agentName.toLowerCase() !== BACKGROUND_AGENT_NAME &&
      !agentNames.has(destination.agentName.toLowerCase())
    ) {
      throw new Error(
        `Invalid http-ingress config (target.to for '${bridge.name}' must reference a configured agent)`,
      );
    }
  }
}

function normalizeBridge(value: unknown, index: number): HttpBridgeConfig {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid http-ingress config (bridges[${index}] must be an object)`);
  }

  const authRaw = value.auth;
  if (!isPlainObject(authRaw)) {
    throw new Error(`Invalid http-ingress config (bridges[${index}].auth must be an object)`);
  }

  const targetRaw = value.target;
  if (!isPlainObject(targetRaw)) {
    throw new Error(`Invalid http-ingress config (bridges[${index}].target must be an object)`);
  }

  const formatterRaw = value.formatter;
  if (!isPlainObject(formatterRaw)) {
    throw new Error(`Invalid http-ingress config (bridges[${index}].formatter must be an object)`);
  }
  if (formatterRaw.metadata !== undefined && !isPlainObject(formatterRaw.metadata)) {
    throw new Error(
      `Invalid http-ingress config (bridges[${index}].formatter.metadata must be an object)`,
    );
  }
  if (
    formatterRaw.includeRawBody !== undefined &&
    typeof formatterRaw.includeRawBody !== "boolean"
  ) {
    throw new Error(
      `Invalid http-ingress config (bridges[${index}].formatter.include-raw-body must be a boolean)`,
    );
  }

  const parseMode = targetRaw.parseMode;
  if (
    parseMode !== undefined &&
    parseMode !== "plain" &&
    parseMode !== "markdownv2" &&
    parseMode !== "html"
  ) {
    throw new Error(
      `Invalid http-ingress config (bridges[${index}].target.parse-mode must be plain|markdownv2|html)`,
    );
  }

  return {
    name: typeof value.name === "string" ? value.name.trim() : "",
    path: typeof value.path === "string" ? value.path.trim() : "",
    auth: {
      header: typeof authRaw.header === "string" ? authRaw.header.trim() : "",
      secret: typeof authRaw.secret === "string" ? authRaw.secret : "",
    },
    target: {
      to: typeof targetRaw.to === "string" ? targetRaw.to.trim() : "",
      senderAgent:
        typeof targetRaw.senderAgent === "string" && targetRaw.senderAgent.trim()
          ? targetRaw.senderAgent.trim()
          : undefined,
      parseMode,
    },
    formatter: {
      text: typeof formatterRaw.text === "string" ? formatterRaw.text : "",
      metadata: formatterRaw.metadata,
      includeRawBody: formatterRaw.includeRawBody === true,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}
