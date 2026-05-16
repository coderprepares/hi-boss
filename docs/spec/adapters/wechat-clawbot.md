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
- Text-only direct-message flow.
- Local sidecar only (`127.0.0.1` or equivalent local networking).
- Inbound text updates from sidecar → Hi-Boss envelopes.
- Agent text replies from Hi-Boss → sidecar `sendmessage`.
- Stable boss identification by sidecar peer id.
- No real WeChat credentials in Hi-Boss DB, envelopes, logs, or prompts.

Out of scope for MVP:
- Media, voice, files, stickers, reactions, and typing indicators.
- Reading arbitrary existing friends/groups or bulk/group automation.
- Payment, transfers, red packets, contacts scraping, friend automation.
- Public webhooks directly to Hi-Boss.

## Sidecar Contract

The sidecar is expected to be a local HTTP service. It may start from the
in-repo `src/wechat-clawbot-sidecar/` scaffold, then add an explicit iLink /
OpenClaw transport later.

The initial in-repo sidecar is independent from the Hi-Boss daemon process. It
uses Node's HTTP server, listens on `127.0.0.1` by default, stores local scaffold
state in a mode-`0600` JSON file, and does not require real WeChat login for
local tests.

### Auth

The sidecar may require `Authorization: Bearer <api-token>`.

Hi-Boss adapter bindings must not store this token inline. Use one of:
- `tokenEnv`: environment variable name containing the token.
- `tokenFile`: root-only local file containing the token.

Token files should be mode `0600`. Do not paste real sidecar tokens into chat,
setup JSON examples, envelopes, or daemon logs.

### `GET /updates`

Fetches text events already polled from iLink by the sidecar.

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
      "text": "hello"
    }
  ],
  "next_cursor": "cursor_2"
}
```

Required event fields:
- `event_id`
- `account_id`
- `peer_id`
- `text`

The sidecar is responsible for:
- QR login and login-state persistence.
- iLink `get_updates_buf` persistence.
- `context_token` persistence per `account_id + peer_id`.
- Deduplication using stable message identifiers.
- Redacting tokens and `context_token` values from logs.

The in-repo scaffold currently provides a file-backed queue with numeric opaque
cursors. Events are deduplicated by stable `message_id` when available, falling
back to `event_id`.

### `POST /accounts/:accountId/peers/:peerId/messages`

Sends a text reply to a peer using the latest stored `context_token`.

Request:

```json
{
  "text": "agent reply"
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

### `GET /healthz`

Returns sidecar process health. This endpoint intentionally does not require
bearer auth so local supervisors can probe it.

Response:

```json
{
  "ok": true,
  "service": "wechat-clawbot-sidecar"
}
```

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

## In-Repo Sidecar Scaffold

Run the local file-backed scaffold without real WeChat credentials:

```bash
npm run wechat-clawbot-sidecar
```

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
| `HIBOSS_WECHAT_CLAWBOT_API_TOKEN_ENV` | unset | Env var name containing bearer token |
| `HIBOSS_WECHAT_CLAWBOT_API_TOKEN_FILE` | unset | File containing bearer token; use mode `0600` |
| `HIBOSS_WECHAT_CLAWBOT_MOCK_INGEST` | `false` | Enables `POST /__mock/events` for local tests |
| `HIBOSS_WECHAT_CLAWBOT_DEFAULT_ACCOUNT` | unset | Fallback account for mock ingest |

Equivalent JSON config:

```json
{
  "host": "127.0.0.1",
  "port": 26322,
  "stateFile": "/root/hiboss/adapters/wechat-clawbot/state.json",
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

A real iLink/OpenClaw transport must be added explicitly and must keep iLink
tokens, QR/login state, `get_updates_buf`, and `context_token` outside Hi-Boss
envelopes, prompts, and logs.

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
sets `defaultAccount`.

## Incoming Flow

1. Sidecar obtains events from mock ingest, or later from iLink `getupdates`.
2. Real transport stores `get_updates_buf` and `context_token` outside Hi-Boss.
3. Hi-Boss adapter polls `GET /updates`.
4. Each event becomes a `ChannelMessage`:
   - `platform = "wechat-clawbot"`
   - `from = channel:wechat-clawbot:<account-id>/<peer-id>`
   - `author.id = <peer-id>`
   - `chat.id = <account-id>/<peer-id>`
   - `content.text = <text>`
5. `ChannelBridge` routes the envelope to the agent bound to the sidecar
   binding token.

## Outgoing Flow

1. Agent sends an envelope to `channel:wechat-clawbot:<account-id>/<peer-id>`.
2. Router verifies the sender agent has a `wechat-clawbot` binding.
3. Adapter calls sidecar `POST /accounts/:accountId/peers/:peerId/messages`.
4. Sidecar sends text via iLink `sendmessage` with the stored `context_token`.

The MVP adapter rejects attachments and empty text.

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
- `/abort`

Commands are handled as boss-only by `ChannelBridge`.

## Security Notes

- Use a test WeChat account and test peer first.
- Keep sidecar auth files outside repo and mode `0600`.
- Do not commit real QR data, iLink tokens, sidecar API tokens, or
  `context_token` values.
- Treat sidecar availability as best-effort; upstream personal-WeChat ClawBot
  behavior may change without Hi-Boss control.
