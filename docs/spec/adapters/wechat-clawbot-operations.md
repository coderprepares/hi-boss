# WeChat ClawBot Operations

This document covers local operations for the WeChat ClawBot sidecar. The
message schema and adapter behavior remain in `docs/spec/adapters/wechat-clawbot.md`.

## Doctor Command

The sidecar binary includes a no-secret doctor command:

```bash
hiboss-wechat-clawbot-sidecar doctor --config /root/hiboss/adapters/wechat-clawbot/sidecar.json
```

To include local Hi-Boss daemon and SQLite state checks, pass the Hi-Boss data
directory and optionally the agent expected to own the `wechat-clawbot` binding:

```bash
hiboss-wechat-clawbot-sidecar doctor \
  --config /root/hiboss/adapters/wechat-clawbot/sidecar.json \
  --hiboss-dir /var/lib/hiboss \
  --agent nex
```

Source checkout equivalent:

```bash
npm run wechat-clawbot-sidecar -- doctor \
  --config /root/hiboss/adapters/wechat-clawbot/sidecar.json \
  --hiboss-dir /var/lib/hiboss \
  --agent nex
```

The command loads the local sidecar config and probes:
- `GET /healthz`
- `GET /status`

By default it does not read Hi-Boss SQLite state, bot token files, sidecar API
token files, or iLink bot tokens. With `--hiboss-dir`, it reads only local
daemon metadata, `daemon.log`, and selected non-secret SQLite rows needed to
check `adapter_boss_id_wechat-clawbot`, persisted adapter cursors, and the
named agent binding. It must not print message text, token values,
`context_token` values, token file paths, state file paths, or adapter tokens.

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
sent-messages: 3
last-sent-at: 2026-05-19T13:28:45.000Z
context-active: 1
context-expiring-soon: 0
context-expired: 0
next-context-expires-at: 2026-05-20T08:05:43.455Z
ilink-poll-enabled: true|false|(none)
ilink-poll-last-started-at: 2026-05-19T12:57:09.380Z
ilink-poll-last-completed-at: 2026-05-19T12:57:07.379Z
ilink-poll-last-error-at: (none)
ilink-poll-last-error: (none)
hiboss-dir: /var/lib/hiboss
hiboss-db-exists: true|false|(none)
hiboss-daemon-pid-file-exists: true|false|(none)
hiboss-daemon-process-alive: true|false|(none)
hiboss-daemon-socket-exists: true|false|(none)
hiboss-agent: nex|(none)
hiboss-agent-exists: true|false|(none)
hiboss-wechat-binding: true|false|(none)
hiboss-boss-id-configured: true|false|(none)
hiboss-wechat-cursor-count: 1
hiboss-wechat-cursor-max: 9
hiboss-cursor-matches-sidecar: true|false|(none)
hiboss-recent-wechat-poll-failures: 0
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
the most recent iLink poll error. With `--hiboss-dir`, warnings also include a
missing daemon PID/socket, missing boss id, missing `wechat-clawbot` binding for
the named agent, absent persisted cursor, or cursor mismatch.

## Monitor Command

The monitor command is a one-shot wrapper around doctor for cron or systemd
timer use. It runs the same checks and sends a notification only when doctor
reports one or more issues:

```bash
hiboss-wechat-clawbot-sidecar monitor \
  --config /root/hiboss/adapters/wechat-clawbot/sidecar.json \
  --hiboss-dir /var/lib/hiboss \
  --agent nex \
  --notify-to channel:telegram:<chat-id>
```

Notification tokens are never accepted inline. The monitor resolves the token
from `--notify-token-env`, `--notify-token-file`, or the local SQLite token for
`--notify-agent` / `--agent` when `--hiboss-dir` is present. It must not print
token values, message text from WeChat, context tokens, token file paths, state
file paths, adapter tokens, or channel identifiers beyond the notification
envelope short id.

By default, repeated notifications with the same issue fingerprint are
suppressed for one hour. Override with `--cooldown-ms <ms>` or set
`--cooldown-file <path>` to control the state location. Use `--dry-run` to test
alert rendering without sending.

Install or repair the cron-based monitor with the repo script:

```bash
scripts/install-wechat-clawbot-monitor.sh \
  --config /root/hiboss/adapters/wechat-clawbot/sidecar.json \
  --hiboss-dir /var/lib/hiboss \
  --agent nex \
  --notify-to channel:telegram:<chat-id> \
  --interval-minutes 5
```

Monitor output is parseable key/value text:

```text
ok: true|false
monitor-status: ok|alert|suppressed|notify-error
doctor-status: ok|warn|error
notified: true|false
dry-run: true|false
cooldown-active: true|false
cooldown-file: /var/lib/hiboss/.daemon/wechat-clawbot-monitor.cooldown.json
cooldown-until: 2026-05-19T14:38:54.551Z
envelope-id: 12345678
notification-error: (none)
pending-outbox: 0
sent-messages: 25
last-sent-at: 2026-05-19T13:38:54.551Z
hiboss-cursor-matches-sidecar: true
hiboss-recent-wechat-poll-failures: 0
issue-count: 0
```

Check whether the cron monitor is installed and recently healthy with:

```bash
hiboss-wechat-clawbot-sidecar monitor-status
```

Status output is parseable key/value text:

```text
ok: true|false
cron-file: /etc/cron.d/hiboss-wechat-clawbot-monitor
cron-file-exists: true|false
cron-command-present: true|false|(none)
cron-notify-target-configured: true|false|(none)
cron-active: true|false|unknown
log-file: /var/log/hiboss-wechat-clawbot-monitor.log
log-file-exists: true|false
last-run-at: 2026-05-19T14:00:00.000Z
last-monitor-status: ok|alert|suppressed|notify-error|(none)
last-doctor-status: ok|warn|error|(none)
last-notified: true|false|(none)
last-issue-count: 0
```

## Production Checks

After deploying sidecar code:
1. Restart the Hi-Boss daemon if adapter code changed.
2. Restart the sidecar process itself if `/status` or sidecar runtime code changed.
3. Run the doctor command.
4. Send one real channel message through `hiboss envelope send` when the reply
   context is active, then confirm `pending-outbox: 0` and `sent-messages:`
   increments in doctor output.
5. For monitoring, schedule the one-shot monitor command outside the daemon,
   preferably to a Telegram channel so WeChat failures can still be reported.
6. Run `hiboss-wechat-clawbot-sidecar monitor-status` after installation and
   after one real cron interval to confirm the system cron path is working.

For the current PM2-style deployment, restart the sidecar process with:

```bash
pm2 restart hiboss-wechat-clawbot-sidecar --update-env
```
