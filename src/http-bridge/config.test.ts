import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeHttpIngressConfig,
  validateHttpIngressConfig,
} from "./config.js";

test("validateHttpIngressConfig requires sender-agent for channel targets", () => {
  const config = normalizeHttpIngressConfig({
    host: "127.0.0.1",
    port: 8787,
    bridges: [
      {
        name: "ops",
        path: "/ops",
        auth: {
          header: "X-Bridge-Secret",
          secret: "secret",
        },
        target: {
          to: "channel:telegram:-100123",
        },
        formatter: {
          text: "hello",
        },
      },
    ],
  });

  assert.throws(
    () => validateHttpIngressConfig(config),
    /target\.sender-agent/,
  );
});

test("validateHttpIngressConfig accepts configured sender-agent and target agent", () => {
  const config = normalizeHttpIngressConfig({
    host: "127.0.0.1",
    port: 8787,
    bridges: [
      {
        name: "ops",
        path: "/ops",
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
          text: "hello",
          includeRawBody: true,
        },
      },
      {
        name: "inbox",
        path: "/inbox",
        auth: {
          header: "X-Bridge-Secret",
          secret: "secret-2",
        },
        target: {
          to: "agent:kai",
        },
        formatter: {
          text: "{json.message}",
        },
      },
    ],
  });

  assert.doesNotThrow(() =>
    validateHttpIngressConfig(config, { agentNames: ["nex", "kai"] }),
  );
});
