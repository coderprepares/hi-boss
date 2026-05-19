# WeChat ClawBot Runtime Commands

This document covers iLink runtime helpers exposed through the local sidecar.
Message schema and adapter flow remain in `docs/spec/adapters/wechat-clawbot.md`.

## `GET /accounts/:accountId/peers/:peerId/config`

Calls iLink `/ilink/bot/getconfig` for the peer using the latest stored
`context_token`.

Request body sent upstream:

```json
{
  "ilink_user_id": "wxid_boss",
  "context_token": "<stored-context-token>",
  "base_info": {
    "channel_version": "1.0.0"
  }
}
```

Sidecar response:

```json
{
  "ok": true,
  "account_id": "acct",
  "peer_id": "wxid_boss",
  "config": {
    "typing_ticket": "..."
  }
}
```

The sidecar caches `typing_ticket` in memory for later typing calls. It must not
print bot tokens or `context_token` values.

## `POST /accounts/:accountId/peers/:peerId/typing`

Sends an iLink `/ilink/bot/sendtyping` request for the peer. If no
`typing_ticket` is cached, the sidecar first calls `getconfig`.

Request:

```json
{
  "status": 1
}
```

`status: 1` starts typing and `status: 2` stops typing.

## `/getconfig`

The WeChat adapter recognizes `/getconfig` as a boss-only channel command. The
command is handled by the adapter after `ChannelBridge` verifies the sender is
the configured boss and resolves the execution lane. The reply shows the raw
`config` object returned by the sidecar.

## Run Typing

For WeChat-originated agent runs, the daemon creates a typing indicator for the
single source chat when all read envelopes come from the same
`channel:wechat-clawbot:<account-id>/<peer-id>` address. Typing starts on
`turn.started`, repeats periodically while the run is active, and stops on
`turn.completed` or final run cleanup.

## Raw Field Trace

Set `HIBOSS_WECHAT_CLAWBOT_TRACE_RAW_FIELDS=true` on the sidecar process to log
raw iLink message field names for protocol investigation.

The trace logs:
- top-level raw message keys;
- `item_list` item keys;
- nested object keys below each item, such as `text_item`, `file_item`, or
  quote-like fields when iLink returns them.

The trace must not print raw field values, message text, media URLs, bot tokens,
or `context_token` values. It is intended for short live probes, such as
checking whether quoted WeChat messages expose reply/quote metadata.
