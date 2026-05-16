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

The sidecar is expected to be a local HTTP service. It may be implemented by
forking `WeClawBot-API` to add an updates queue, or by implementing the iLink
`getupdates` / `sendmessage` protocol directly.

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

1. Sidecar logs in via QR code and polls iLink `getupdates`.
2. Sidecar stores `get_updates_buf` and `context_token`.
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
