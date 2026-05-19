#!/usr/bin/env node
import {
  loadWechatClawbotSidecarConfig,
  parseSidecarCliArgs,
  resolveWechatClawbotSidecarApiToken,
} from "./config.js";
import {
  formatWechatClawbotDoctorResult,
  runWechatClawbotDoctor,
} from "./doctor.js";
import { runWechatClawbotLogin } from "./login.js";
import { WechatClawbotSidecarServer } from "./server.js";

function printUsage(): void {
  console.log(`Usage:
  hiboss-wechat-clawbot-sidecar [--config ./sidecar.json]
  hiboss-wechat-clawbot-sidecar doctor [--config ./sidecar.json]
  hiboss-wechat-clawbot-sidecar login [--config ./sidecar.json]
  hiboss-wechat-clawbot-sidecar login-help

Source checkout equivalent:
  npm run wechat-clawbot-sidecar -- [--config ./sidecar.json]
  npm run wechat-clawbot-sidecar -- doctor [--config ./sidecar.json]
  npm run wechat-clawbot-sidecar -- login [--config ./sidecar.json]
  npm run wechat-clawbot-sidecar -- login-help

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

function printLoginHelp(): void {
  console.log(`WeChat ClawBot login/token setup

Run QR login in this terminal to obtain an iLink bot token without printing it:

  hiboss-wechat-clawbot-sidecar login --config /root/hiboss/adapters/wechat-clawbot/sidecar.json

The login command writes the bot token to a root-only token file and updates the
sidecar config with a botTokenFile reference. If you already have a bot token
from a trusted iLink helper, store it in a root-only file:

  install -m 700 -d /root/hiboss/adapters/wechat-clawbot
  install -m 600 /dev/null /root/hiboss/adapters/wechat-clawbot/ilink-bot-token
  printf '%s\\n' '<paste-token-locally>' > /root/hiboss/adapters/wechat-clawbot/ilink-bot-token

Then reference the token file from sidecar config:

  {
    "transport": "ilink",
    "stateFile": "/root/hiboss/adapters/wechat-clawbot/state.json",
    "ilinkAccounts": [
      {
        "accountId": "test-account",
        "botTokenFile": "/root/hiboss/adapters/wechat-clawbot/ilink-bot-token"
      }
    ]
  }

Start the sidecar after login:

  hiboss-wechat-clawbot-sidecar --config /root/hiboss/adapters/wechat-clawbot/sidecar.json

Check local status without exposing message text, bot tokens, or context tokens:

  curl -fsS http://127.0.0.1:26322/status

Run the local no-secret doctor check:

  hiboss-wechat-clawbot-sidecar doctor --config /root/hiboss/adapters/wechat-clawbot/sidecar.json

Do not send bot tokens, QR data, context tokens, or state files through chat.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }
  if (args.includes("login-help")) {
    printLoginHelp();
    return;
  }
  if (args.includes("doctor")) {
    const { configPath, overrides } = parseSidecarCliArgs(args.filter((arg) => arg !== "doctor"));
    if (overrides.length > 0) {
      throw new Error(`Unknown arguments: ${overrides.join(" ")}`);
    }
    const config = loadWechatClawbotSidecarConfig(configPath);
    const result = await runWechatClawbotDoctor({ config });
    console.log(formatWechatClawbotDoctorResult(result));
    if (result.status === "error") process.exitCode = 1;
    return;
  }
  if (args.includes("login")) {
    const { configPath, overrides } = parseSidecarCliArgs(args.filter((arg) => arg !== "login"));
    if (overrides.length > 0) {
      throw new Error(`Unknown arguments: ${overrides.join(" ")}`);
    }
    await runWechatClawbotLogin({ configPath });
    return;
  }

  const { configPath, overrides } = parseSidecarCliArgs(args);
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
