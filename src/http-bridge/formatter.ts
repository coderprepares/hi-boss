import type { HttpBridgeConfig } from "./types.js";

export interface HttpBridgeRequestContext {
  method: string;
  path: string;
  receivedAt: string;
}

export interface RenderHttpBridgePayloadParams {
  bridge: HttpBridgeConfig;
  body: unknown;
  request: HttpBridgeRequestContext;
}

export interface RenderedHttpBridgePayload {
  text: string;
  metadata: Record<string, unknown>;
}

export function renderHttpBridgePayload(
  params: RenderHttpBridgePayloadParams,
): RenderedHttpBridgePayload {
  const context = {
    json: params.body,
    bridge: {
      name: params.bridge.name,
      path: params.bridge.path,
    },
    request: params.request,
  };

  const text = renderTemplate(params.bridge.formatter.text, context).trim();
  if (!text) {
    throw new Error("Rendered HTTP bridge message is empty");
  }

  const metadata = renderMetadataValue(
    params.bridge.formatter.metadata ?? {},
    context,
  );
  if (!isRecord(metadata)) {
    throw new Error("Rendered HTTP bridge metadata must be an object");
  }

  const standardMetadata: Record<string, unknown> = {
    httpBridge: {
      name: params.bridge.name,
      path: params.bridge.path,
      method: params.request.method,
      receivedAt: params.request.receivedAt,
      ...(params.bridge.formatter.includeRawBody ? { body: params.body } : {}),
    },
  };

  return {
    text,
    metadata: {
      ...metadata,
      ...standardMetadata,
    },
  };
}

function renderMetadataValue(
  value: unknown,
  context: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    return renderTemplate(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderMetadataValue(item, context));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        renderMetadataValue(nested, context),
      ]),
    );
  }
  return value;
}

function renderTemplate(
  template: string,
  context: Record<string, unknown>,
): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, expression: string) => {
    const value = resolvePath(context, expression.trim());
    return stringifyTemplateValue(value);
  });
}

function resolvePath(root: unknown, expression: string): unknown {
  if (!expression) {
    return "";
  }

  const parts = expression.split(".").filter(Boolean);
  let current: unknown = root;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return "";
    }
    if (Array.isArray(current)) {
      current = current[Number(part)];
      continue;
    }
    if (typeof current !== "object") {
      return "";
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
