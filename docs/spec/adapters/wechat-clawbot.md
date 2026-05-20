# WeChat ClawBot Adapter

The WeChat ClawBot adapter connects Hi-Boss to a **local sidecar** that owns the
personal-WeChat ClawBot / OpenClaw weixin runtime.

This is intentionally not a native personal-WeChat implementation inside the
daemon. The sidecar isolates Node/OpenClaw runtime requirements, QR login state,
iLink tokens, `context_token` storage, and upstream protocol churn from the
Hi-Boss process.

Key files:
- `src/adapters/wechat-clawbot.adapter.ts` — Hi-Boss adapter skeleton
- `src/adapters/wechat-clawbot/sidecar-client.ts` — sidecar contract client and mapping helpers
- `src/wechat-clawbot-sidecar/` — local sidecar scaffold, file-backed state store, mock ingest endpoint, HTTP server, CLI
- `src/daemon/bridges/channel-bridge.ts` — channel message/command → envelope bridge

## Scope

MVP scope:
- Direct-message text flow plus image/video/file attachments over iLink CDN media.
- Local sidecar only (`127.0.0.1` or equivalent local networking).
- Inbound text and downloaded image/video/file/voice attachments from sidecar → Hi-Boss envelopes.
- Agent text/image/video/file replies from Hi-Boss → sidecar `sendmessage`.
- Stable boss identification by sidecar peer id.
- No real WeChat credentials in Hi-Boss DB, envelopes, logs, or prompts.

Out of scope for MVP: stickers, reactions, bulk/group automation, payment,
transfers, red packets, contacts scraping, friend automation, voice transcoding,
and public webhooks directly to Hi-Boss.

## Sidecar Contract

The sidecar is a local HTTP service independent from the Hi-Boss daemon process.
The in-repo implementation uses Node's HTTP server, listens on `127.0.0.1` by
default, stores local state in a mode-`0600` JSON file, and supports both mock
tests and iLink-backed WeChat sessions.

The sidecar has two transport modes:
- `mock` — default, local-only development mode with optional mock event ingest.
- `ilink` — calls OpenClaw/iLink-style `/ilink/bot/getupdates` and
  `/ilink/bot/sendmessage` endpoints using bot tokens supplied by env or token
  files. QR login is available through the sidecar CLI and writes bot tokens to
  token files instead of printing or embedding them in config.

### Auth

The sidecar may require `Authorization: Bearer <api-token>`.

Hi-Boss adapter bindings must not store this token inline. Use one of:
- `tokenEnv`: environment variable name containing the token.
- `tokenFile`: root-only local file containing the token.

Token files should be mode `0600`. Do not paste real sidecar tokens into chat,
setup JSON examples, envelopes, or daemon logs.

### `GET /updates`

Fetches message events already polled from iLink by the sidecar.

Query:
- `cursor` — optional opaque cursor returned by the previous call.

Response:

```json
{
  "events": [
    {
      "event_id": "evt_123",
      "account_id": "test-account",
      "peer_id": "wxid_example",
      "peer_name": "Boss",
      "message_id": "msg_123",
      "text": "hello",
      "attachments": [{ "source": "/root/hiboss/media/wechat-clawbot/image.jpg", "filename": "image.jpg" }]
    }
  ],
  "next_cursor": "cursor_2"
}
```

Required event fields: `event_id`, `account_id`, `peer_id`, and either `text` or `attachments`.

The sidecar is responsible for:
- QR login and login-state persistence.
- iLink `get_updates_buf` persistence.
- `context_token` persistence per `account_id + peer_id`, including the
  local reply-window expiry time derived from the latest inbound message.
- Pending outbound persistence when iLink `sendmessage` fails because the
  reply context is expired or otherwise unusable.
- Deduplication using stable message identifiers.
- Redacting tokens and `context_token` values from logs.

The in-repo scaffold provides a file-backed queue with numeric opaque cursors.
Events are deduplicated by stable `message_id` when available, falling back to
`event_id`. In `ilink` transport mode, the sidecar persists each account's
`get_updates_buf` and each peer's latest `context_token` reference in the local
state file. The context is treated as a reply window, not a one-reply token:
multiple outbound messages may be sent while the context remains valid. When an
outbound send fails, the sidecar records the attempted text in a local
`pending_outbox`. The next inbound message from the same peer refreshes the
context and the sidecar attempts to flush pending messages, merging multiple
pending items into a single summary when appropriate.

### `POST /accounts/:accountId/peers/:peerId/messages`

Sends a text and/or local image/video/file attachment reply using the latest stored `context_token`.

Request:

```json
{
  "text": "agent reply",
  "attachments": [{ "source": "/root/hiboss/media/report.pdf", "filename": "report.pdf" }]
}
```

Response:

```json
{
  "ok": true
}
```

The sidecar should return a clear `4xx` error when the peer has no active
`context_token` yet. Operators should have the peer send one test message first.
If iLink rejects an attempted send after a peer context exists, the sidecar
queues the text in `pending_outbox` and returns an error indicating that the
message was queued for the next peer activation.

### `GET /healthz`

Returns sidecar process health. This endpoint intentionally does not require
bearer auth so local supervisors can probe it.

Response:

```json
{
  "ok": true,
  "service": "wechat-clawbot-sidecar",
  "transport": "mock"
}
```

### `GET /status`

Returns no-secret operational status for local diagnostics. The response
includes transport, poll timing, state counters, pending outbox counts, context
expiry counts, last event/sent timestamps, and the latest redacted iLink poll
error. It does not include message text, bot tokens, sidecar API tokens,
`context_token` values, token file paths, or state file paths.

This endpoint intentionally does not require bearer auth so local supervisors can
probe it. Keep the sidecar bound to loopback unless explicitly testing
non-local binds.

### `GET /accounts`

Returns known local accounts and peer counts without secrets.

Response:

```json
{
  "accounts": [
    {
      "account_id": "test-account",
      "peers": 1
    }
  ]
}
```

### `POST /__mock/events`

Development-only route enabled by `mockIngestEnabled: true`.

Request:

```json
{
  "account_id": "test-account",
  "peer_id": "wxid_boss",
  "peer_name": "Boss",
  "message_id": "msg_1",
  "text": "hello"
}
```

This route creates a local event, stores a mock context reference for the peer,
and makes the event visible through `GET /updates`. It is for mock adapter tests
only and must stay disabled for real QR/iLink deployments.

## Adapter Binding

Adapter type:

```text
wechat-clawbot
```

Recommended binding token shape:

```json
{
  "baseUrl": "http://127.0.0.1:26322",
  "tokenEnv": "HIBOSS_WECHAT_CLAWBOT_API_TOKEN",
  "pollIntervalMs": 2000
}
```

For local mock tests only, `baseUrl` can be provided without auth:

```text
http://127.0.0.1:26322
```

Do not include `apiToken`, `token`, iLink `bot_token`, QR codes, or
`context_token` values in the adapter binding token.

### Adapter Cursor Persistence

The daemon persists the Hi-Boss adapter's `/updates` cursor in SQLite `config`
under an internal key derived from the adapter type and a hash of the binding
token. The raw binding token is not included in the key. On restart, the adapter
resumes from the stored cursor so sidecar history is not replayed.

When a binding has no stored cursor yet, the daemon advances the sidecar cursor
to the current tail without dispatching existing events. This prevents old
sidecar scaffold or iLink history from being treated as new inbound messages
when WeChat is first bound. After that bootstrap, messages received while the
daemon is down are delivered on the next start because the previous cursor is
already stored.

## In-Repo Sidecar Scaffold

Run the local file-backed scaffold without real WeChat credentials:

```bash
npm run wechat-clawbot-sidecar
```

After `npm run build` or package installation, the published sidecar binary is:

```bash
hiboss-wechat-clawbot-sidecar --config /root/hiboss/adapters/wechat-clawbot/sidecar.json
```

Print safe local token setup guidance:

```bash
npm run wechat-clawbot-sidecar -- login-help
```

Start QR login directly in the terminal:

```bash
npm run wechat-clawbot-sidecar -- login --config /root/hiboss/adapters/wechat-clawbot/sidecar.json
```

The command:
- Fetches a WeChat ClawBot QR code from `/ilink/bot/get_bot_qrcode?bot_type=3`.
- Renders the QR code in the terminal.
- Polls `/ilink/bot/get_qrcode_status` until confirmed, expired, or timed out.
- Writes the returned bot token to
  `/root/hiboss/adapters/wechat-clawbot/<account-id>.bot-token` with mode
  `0600`.
- Updates the sidecar config with `transport: "ilink"` and an `ilinkAccounts`
  entry that points to `botTokenFile`.

The token value is never printed and is not written inline into config.

Default listener:

```text
http://127.0.0.1:26322
```

Environment configuration:

| Variable | Default | Notes |
|----------|---------|-------|
| `HIBOSS_WECHAT_CLAWBOT_HOST` | `127.0.0.1` | Bind host; keep loopback for MVP |
| `HIBOSS_WECHAT_CLAWBOT_PORT` | `26322` | HTTP port |
| `HIBOSS_WECHAT_CLAWBOT_STATE_FILE` | `.wechat-clawbot-sidecar/state.json` | File-backed scaffold state |
| `HIBOSS_WECHAT_CLAWBOT_MEDIA_DIR` | next to state file | Downloaded inbound image/video/file attachments |
| `HIBOSS_WECHAT_CLAWBOT_TRANSPORT` | `mock` | `mock` or `ilink` |
| `HIBOSS_WECHAT_CLAWBOT_API_TOKEN_ENV` | unset | Env var name containing bearer token |
| `HIBOSS_WECHAT_CLAWBOT_API_TOKEN_FILE` | unset | File containing bearer token; use mode `0600` |
| `HIBOSS_WECHAT_CLAWBOT_MOCK_INGEST` | `false` | Enables `POST /__mock/events` for local tests |
| `HIBOSS_WECHAT_CLAWBOT_DEFAULT_ACCOUNT` | unset | Fallback account for mock ingest |
| `HIBOSS_WECHAT_CLAWBOT_ILINK_API_BASE_URL` | `https://ilinkai.weixin.qq.com` | iLink API root |
| `HIBOSS_WECHAT_CLAWBOT_ILINK_CDN_BASE_URL` | `https://novac2c.cdn.weixin.qq.com/c2c` | iLink CDN upload fallback root |
| `HIBOSS_WECHAT_CLAWBOT_POLL_INTERVAL_MS` | `2000` | iLink poll interval |
| `HIBOSS_WECHAT_CLAWBOT_REQUEST_TIMEOUT_MS` | `35000` | iLink HTTP timeout |

Equivalent JSON config:

```json
{
  "host": "127.0.0.1",
  "port": 26322,
  "stateFile": "/root/hiboss/adapters/wechat-clawbot/state.json",
  "transport": "mock",
  "apiTokenEnv": "HIBOSS_WECHAT_CLAWBOT_API_TOKEN",
  "mockIngestEnabled": false,
  "defaultAccount": "test-account"
}
```

Example local mock run:

```bash
HIBOSS_WECHAT_CLAWBOT_MOCK_INGEST=true \
HIBOSS_WECHAT_CLAWBOT_DEFAULT_ACCOUNT=test-account \
npm run wechat-clawbot-sidecar
```

Then bind Hi-Boss with a placeholder adapter token shape:

```json
{
  "baseUrl": "http://127.0.0.1:26322",
  "pollIntervalMs": 2000
}
```

Local mock smoke flow:

```bash
export HIBOSS_WECHAT_CLAWBOT_API_TOKEN='local-test-token'
export HIBOSS_WECHAT_CLAWBOT_MOCK_INGEST=true
export HIBOSS_WECHAT_CLAWBOT_DEFAULT_ACCOUNT=test-account
npm run wechat-clawbot-sidecar
```

In another shell, inject a test message:

```bash
curl -sS http://127.0.0.1:26322/__mock/events \
  -H 'Authorization: Bearer local-test-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "account_id": "test-account",
    "peer_id": "wxid_boss",
    "peer_name": "Boss",
    "message_id": "msg_1",
    "text": "hello from mock wechat"
  }'
```

Hi-Boss should bind the adapter with this token shape:

```json
{
  "baseUrl": "http://127.0.0.1:26322",
  "tokenEnv": "HIBOSS_WECHAT_CLAWBOT_API_TOKEN",
  "pollIntervalMs": 2000
}
```

The automated equivalent is covered by
`src/adapters/wechat-clawbot.integration.test.ts`.

If bearer auth is enabled, create a local token file outside the repo:

```bash
install -m 600 /dev/null /tmp/wechat-clawbot-sidecar-token
printf '%s\n' '<replace-with-local-test-token>' > /tmp/wechat-clawbot-sidecar-token
```

Then set:

```bash
HIBOSS_WECHAT_CLAWBOT_API_TOKEN_FILE=/tmp/wechat-clawbot-sidecar-token
```

The sidecar config parser rejects inline `apiToken`, `token`, `botToken`, and
`contextToken` fields. Secrets must be provided by env indirection or token
files only.

The iLink/OpenClaw transport keeps iLink tokens, QR/login state,
`get_updates_buf`, and `context_token` outside Hi-Boss envelopes, prompts, and
logs.

Example `ilink` transport config:

```json
{
  "host": "127.0.0.1",
  "port": 26322,
  "stateFile": "/root/hiboss/adapters/wechat-clawbot/state.json",
  "transport": "ilink",
  "apiTokenFile": "/root/hiboss/adapters/wechat-clawbot/api-token",
  "ilinkAccounts": [
    {
      "accountId": "test-account",
      "botTokenFile": "/root/hiboss/adapters/wechat-clawbot/ilink-bot-token",
      "xWechatUin": "123456"
    }
  ]
}
```

The sidecar sends iLink requests with:
- `AuthorizationType: ilink_bot_token`
- `Authorization: Bearer <bot-token>`
- optional `X-WECHAT-UIN`

For `getupdates`, it POSTs the persisted `get_updates_buf`. For
`sendmessage`, it POSTs `msg.context_token` with a text item in
`msg.item_list`. Bot tokens must be provided through `botTokenEnv` or
`botTokenFile`; inline bot tokens are rejected.

## Address Format

```text
channel:wechat-clawbot:<account-id>/<peer-id>
```

Examples:

```text
channel:wechat-clawbot:test-account/wxid_boss
channel:wechat-clawbot:bot_123/wxid_example
```

The slash-separated chat id lets the adapter route replies to the correct
sidecar account and peer. Bare peer ids are only valid when the adapter binding
sets `defaultAccount`; adapter HTTP timeout defaults to `60000` ms and can be overridden by `requestTimeoutMs`.

## Multi-Account Execution Model

The sidecar can hold multiple iLink bot accounts, but account isolation does not
automatically imply independent AI execution. See
`docs/spec/adapters/wechat-clawbot-execution.md` for the execution-lane model
and recommended multi-account rollout.

## Incoming Flow

1. Sidecar obtains events from mock ingest or iLink `getupdates`.
2. iLink transport stores `get_updates_buf`, `context_token`, context expiry, and pending outbound messages outside Hi-Boss.
3. Hi-Boss adapter polls `GET /updates`.
4. Each event becomes a `ChannelMessage`:
   - `platform = "wechat-clawbot"`
   - `from = channel:wechat-clawbot:<account-id>/<peer-id>`
   - `author.id = <peer-id>`
   - `chat.id = <account-id>/<peer-id>`
   - `content.text = <text>` when present
   - `content.attachments = <downloaded image/video/file/voice paths>` when present
   - `inReplyTo.text` / `inReplyTo.attachments` when iLink returns quoted text or media in `ref_msg.message_item`
   - `inReplyTo.channelMessageId` only when the sidecar uniquely matches the quote to a stored prior event in the same account and peer
5. `ChannelBridge` routes the envelope to the agent bound to the sidecar binding token.

## Outgoing Flow

1. Agent sends an envelope to `channel:wechat-clawbot:<account-id>/<peer-id>`.
2. Router verifies the sender agent has a `wechat-clawbot` binding.
3. Adapter calls sidecar `POST /accounts/:accountId/peers/:peerId/messages`.
4. Sidecar sends text via `sendmessage` after normalizing CRLF/CR line breaks to LF; image/video/file attachments are AES-encrypted and sent as iLink CDN media items.
5. If iLink text send fails after a context exists, sidecar queues the outbound
   text and flushes it after the next inbound peer message refreshes the context.

The MVP adapter rejects empty content. Attachment sends require local file paths
and are not queued on send failure.

## Boss Identification

Set `adapter_boss_id_wechat-clawbot` to the stable sidecar peer id, such as:

```text
wxid_boss
```

The channel bridge compares this value with `ChannelMessage.author.id` and
`ChannelCommand.authorId`. Do not rely on display names.

## Commands

The adapter recognizes these text commands when received as exact slash
commands from the sidecar:
- `/new`
- `/new <agent-name>`
- `/status`
- `/status <agent-name>`
- `/abort [agent-name]`
- `/help`
Commands are handled as boss-only by `ChannelBridge`; replies use blank-line-separated logical lines so WeChat desktop and mobile render line breaks consistently.

## Security Notes

- Use a test WeChat account and test peer first.
- Keep sidecar auth files outside repo and mode `0600`.
- Do not commit real QR data, iLink tokens, sidecar API tokens, or
  `context_token` values.
- Treat sidecar availability as best-effort; upstream personal-WeChat ClawBot
  behavior may change without Hi-Boss control.
