# WeChat ClawBot Operations

This document covers local operations for the WeChat ClawBot sidecar. The
message schema and adapter behavior remain in `docs/spec/adapters/wechat-clawbot.md`.

## Doctor Command

The sidecar binary includes a no-secret doctor command:

```bash
hiboss-wechat-clawbot-sidecar doctor --config /root/hiboss/adapters/wechat-clawbot/sidecar.json
```

Source checkout equivalent:

```bash
npm run wechat-clawbot-sidecar -- doctor --config /root/hiboss/adapters/wechat-clawbot/sidecar.json
```

The command loads the local sidecar config and probes:
- `GET /healthz`
- `GET /status`

It does not read Hi-Boss SQLite state, bot token files, sidecar API token files,
or iLink bot tokens. It must not print message text, token values,
`context_token` values, token file paths, or state file paths.

Output is parseable key/value text:

```text
ok: true|false
status: ok|warn|error
sidecar-url: http://127.0.0.1:26322
health-ok: true|false|(none)
health-transport: mock|ilink|(none)
status-ok: true|false|(none)
transport: mock|ilink|(none)
accounts: 1
peers: 1
events: 9
next-cursor: 9
pending-outbox: 0
context-active: 1
context-expiring-soon: 0
context-expired: 0
next-context-expires-at: 2026-05-20T08:05:43.455Z
ilink-poll-enabled: true|false|(none)
ilink-poll-last-started-at: 2026-05-19T12:57:09.380Z
ilink-poll-last-completed-at: 2026-05-19T12:57:07.379Z
ilink-poll-last-error-at: (none)
ilink-poll-last-error: (none)
issue-count: 0
```

When issues exist, they are printed as indexed blocks:

```text
issue-1-level: warning
issue-1-name: pending-outbox
issue-1-message: sidecar has queued outbound messages
```

`status: error` means a core endpoint failed, returned malformed data, or the
status response appears to expose sensitive fields. The process exits non-zero
only for `error`.

`status: warn` means the sidecar is reachable but has an operational concern,
such as queued outbound messages, expired contexts, missing active context, or
the most recent iLink poll error.

## Production Checks

After deploying sidecar code:
1. Restart the Hi-Boss daemon if adapter code changed.
2. Restart the sidecar process itself if `/status` or sidecar runtime code changed.
3. Run the doctor command.
4. Send one real channel message through `hiboss envelope send` when the reply
   context is active, then confirm `pending-outbox: 0` and `sent_messages`
   increments in `/status`.

For the current PM2-style deployment, restart the sidecar process with:

```bash
pm2 restart hiboss-wechat-clawbot-sidecar --update-env
```
