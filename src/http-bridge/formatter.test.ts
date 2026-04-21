import assert from "node:assert/strict";
import test from "node:test";

import { renderHttpBridgePayload } from "./formatter.js";
import type { HttpBridgeConfig } from "./types.js";

test("renderHttpBridgePayload interpolates text and includes raw body metadata", () => {
  const bridge: HttpBridgeConfig = {
    name: "provider-alerts",
    path: "/bridges/provider-alerts",
    auth: {
      header: "X-Bridge-Secret",
      secret: "secret",
    },
    target: {
      to: "channel:telegram:-100123",
      senderAgent: "nex",
      parseMode: "html",
    },
    formatter: {
      text: "[{json.event}] {json.provider.name} -> {json.circuit.state}",
      metadata: {
        event: "{json.event}",
        provider: "{json.provider.name}",
        nested: {
          model: "{json.request.model}",
        },
      },
      includeRawBody: true,
    },
  };

  const rendered = renderHttpBridgePayload({
    bridge,
    body: {
      event: "provider.unavailable",
      provider: {
        name: "apirouter",
      },
      circuit: {
        state: "open",
      },
      request: {
        model: "gpt-5.1",
      },
    },
    request: {
      method: "POST",
      path: bridge.path,
      receivedAt: "2026-04-21T12:00:00.000Z",
    },
  });

  assert.equal(rendered.text, "[provider.unavailable] apirouter -> open");
  assert.deepEqual(rendered.metadata, {
    event: "provider.unavailable",
    provider: "apirouter",
    nested: {
      model: "gpt-5.1",
    },
    httpBridge: {
      name: "provider-alerts",
      path: "/bridges/provider-alerts",
      method: "POST",
      receivedAt: "2026-04-21T12:00:00.000Z",
      body: {
        event: "provider.unavailable",
        provider: {
          name: "apirouter",
        },
        circuit: {
          state: "open",
        },
        request: {
          model: "gpt-5.1",
        },
      },
    },
  });
});
