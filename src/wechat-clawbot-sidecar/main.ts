#!/usr/bin/env node
import {
  loadWechatClawbotSidecarConfig,
  parseSidecarCliArgs,
  resolveWechatClawbotSidecarApiToken,
} from "./config.js";
import { WechatClawbotSidecarServer } from "./server.js";

function printUsage(): void {
  console.log(`Usage: tsx src/wechat-clawbot-sidecar/main.ts [--config ./sidecar.json]

Environment defaults:
  HIBOSS_WECHAT_CLAWBOT_HOST
  HIBOSS_WECHAT_CLAWBOT_PORT
  HIBOSS_WECHAT_CLAWBOT_STATE_FILE
  HIBOSS_WECHAT_CLAWBOT_TRANSPORT
  HIBOSS_WECHAT_CLAWBOT_API_TOKEN_ENV
  HIBOSS_WECHAT_CLAWBOT_API_TOKEN_FILE
  HIBOSS_WECHAT_CLAWBOT_MOCK_INGEST
  HIBOSS_WECHAT_CLAWBOT_DEFAULT_ACCOUNT
  HIBOSS_WECHAT_CLAWBOT_ILINK_API_BASE_URL
  HIBOSS_WECHAT_CLAWBOT_POLL_INTERVAL_MS
  HIBOSS_WECHAT_CLAWBOT_REQUEST_TIMEOUT_MS
`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }

  const { configPath, overrides } = parseSidecarCliArgs(process.argv.slice(2));
  if (overrides.length > 0) {
    throw new Error(`Unknown arguments: ${overrides.join(" ")}`);
  }

  const config = loadWechatClawbotSidecarConfig(configPath);
  const apiToken = resolveWechatClawbotSidecarApiToken(config);
  const sidecar = new WechatClawbotSidecarServer(config, { apiToken });

  const stop = async () => {
    await sidecar.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await sidecar.start();
  console.log(`wechat-clawbot sidecar listening on ${sidecar.url()}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
