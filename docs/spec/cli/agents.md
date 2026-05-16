# CLI: Agents

Note: Hi-Boss currently runs provider CLIs in **full-access mode** (bypassing sandboxing / permission prompts) so agents can reliably execute `hiboss` commands.

## `hiboss agent register`

Registers a new agent.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)
- `--role <speaker|leader>` (required)
- `--description <description>` (optional)
- `--workspace <path>` (optional)
- `--provider <claude|codex>` (required)
- `--model <model>` (optional)
- `--reasoning-effort <default|none|low|medium|high|xhigh>` (optional; use `default` to clear and use provider default)
- `--permission-level <restricted|standard|privileged|boss>` (optional; `boss` requires boss-privileged token)
- `--metadata-json <json>` or `--metadata-file <path>` (optional)
- Optional binding at creation:
  - `--bind-adapter-type <type>`
  - `--bind-adapter-token <token>`
- Optional session policy inputs:
  - `--session-daily-reset-at HH:MM`
  - `--session-idle-timeout <duration>` (units: `d/h/m/s`)
  - `--session-max-context-length <n>`
- `--dry-run` (optional; validate only, no mutation)

Behavior when flags are omitted:
Required flags (validation error):
- `provider`
- `role`

Optional flags (defaults):
- `model`: provider default (`NULL` override)
- `reasoning-effort`: provider default (`NULL` override)
- `permission-level`: `standard`
- `description`: generated default description
- `workspace`: unset (`NULL`)
- `session-policy`: unset
- `metadata`: unset

Notes:
- `--role speaker` requires binding at registration (`--bind-adapter-type` + `--bind-adapter-token`).
- `--model default` on register clears the model override to provider default (`NULL`).
- `--reasoning-effort default` on register clears the reasoning-effort override to provider default (`NULL`).

Provider-home behavior follows `docs/spec/cli/conventions.md#provider-homes`.

Output (parseable):
- `name:`
- `role:`
- `description:` (always; generated default when omitted; may be empty string)
- `workspace:` (`(none)` when unset)
- `token:` (printed once)
- `dry-run: true` (only when `--dry-run` is set)

Note:
- In `agent register` output, `workspace: (none)` means no explicit override is stored. Effective runtime workspace falls back to the user's home directory.
- In dry-run mode, `token:` is rendered as `(dry-run)` and no agent/token is persisted.

## `hiboss agent set`

Updates agent settings and (optionally) binds/unbinds adapters.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)
- `--role <speaker|leader>` (optional; explicit role assignment)
- `--description <description>` (optional)
- `--workspace <path>` (optional)
- `--provider <claude|codex>` (optional)
- `--model <model>` (optional; use `default` to clear and use provider default)
- `--reasoning-effort <default|none|low|medium|high|xhigh>` (optional)
- `--permission-level <restricted|standard|privileged|boss>` (optional; boss-privileged token only)
- Session policy:
  - `--session-daily-reset-at HH:MM` (optional)
  - `--session-idle-timeout <duration>` (optional; units: `d/h/m/s`)
  - `--session-max-context-length <n>` (optional)
  - `--clear-session-policy` (optional)
- Metadata:
  - `--metadata-json <json>` or `--metadata-file <path>` (optional)
  - `--clear-metadata` (optional)
- Binding:
  - `--bind-adapter-type <type>` + `--bind-adapter-token <token>` (optional)
  - `--unbind-adapter-type <type>` (optional)

Notes:
- Updating `--provider`, `--model`, or `--reasoning-effort` does **not** force a session refresh. Existing/resumed sessions may continue using the previous session config until a refresh (`/new`) or policy refresh opens a new session.
- When switching providers without specifying `--model` / `--reasoning-effort`, Hi-Boss clears these overrides so the new provider can use its defaults when a fresh session is eventually opened.
- `--clear-metadata` clears user metadata but preserves the internal session resume handle (`metadata.sessionHandle`). The `sessionHandle` key is reserved and is ignored if provided via `--metadata-*`.
- Role/binding mutations are rejected when they would violate the required role invariant (`>=1 speaker` and `>=1 leader`).
- Speakers must keep at least one binding.
- `--role speaker` requires at least one resulting binding in the same command.
- `--bind-adapter-*` and `--unbind-adapter-type` may be used together for same-command binding swaps.
- `--bind-adapter-*` alone replaces an existing binding token for that same adapter type on the target agent (atomic replace).
- Execution lanes are configured with `--metadata-json` / `--metadata-file` using `metadata.executionLane`; keep credentials out of metadata.

Provider-home behavior follows `docs/spec/cli/conventions.md#provider-homes`.

Output (parseable):
- `success: true|false`
- `agent-name:`
- `role:`
- `description:` (`(none)` when unset)
- `workspace:` (`(none)` when unset)
- `provider:` (`(none)` when unset)
- `model:` (`default` when unset)
- `reasoning-effort:` (`default` when unset)
- `permission-level:`
- `bindings:` (`(none)` when no bindings; otherwise comma-separated adapter types)
- `session-daily-reset-at:` (optional)
- `session-idle-timeout:` (optional)
- `session-max-context-length:` (optional)

### Execution Lane Runbook

Execution lanes split one adapter binding by stable channel identity, then give
that lane its own speaker, default leader / leader pool guidance, and optional
background job cap. See `docs/spec/components/routing.md#channel-identity-routing--execution-lanes`
for daemon routing semantics.

#### 1. Configure a lane on the target speaker

Create a metadata file for the speaker that should receive the lane. `agent set`
replaces user metadata, while preserving the internal `sessionHandle`; include
any other existing custom metadata keys you still need. Do not include adapter
tokens, bot tokens, iLink tokens, or `context_token` values.

Minimal Telegram lane:

```bash
cat > /tmp/nex-telegram-lane.json <<'JSON'
{
  "executionLane": {
    "id": "boss-telegram",
    "channelRoutes": [
      {
        "adapterType": "telegram",
        "chatId": "1124674058",
        "authorId": "1124674058"
      }
    ],
    "defaultLeader": "kai",
    "leaderPool": ["kai"],
    "backgroundMaxConcurrent": 1
  }
}
JSON

hiboss agent set --name nex --metadata-file /tmp/nex-telegram-lane.json
```

Minimal WeChat ClawBot lane:

```bash
cat > /tmp/wechat-speaker-lane.json <<'JSON'
{
  "executionLane": {
    "id": "boss-wechat",
    "channelRoutes": [
      {
        "adapterType": "wechat-clawbot",
        "accountId": "d24a7e25e5bd@im.bot",
        "peerId": "o9cq807H2WYX2riwsrUEKvN1j4QA@im.wechat"
      }
    ],
    "defaultLeader": "kai",
    "leaderPool": ["kai"],
    "backgroundMaxConcurrent": 1
  }
}
JSON

hiboss agent set --name wechat-speaker --metadata-file /tmp/wechat-speaker-lane.json
```

You can also pass the same JSON inline:

```bash
hiboss agent set --name nex --metadata-json '{"executionLane":{"id":"boss-telegram","channelRoutes":[{"adapterType":"telegram","chatId":"1124674058"}],"defaultLeader":"kai","leaderPool":["kai"],"backgroundMaxConcurrent":1}}'
```

#### 2. Choose route fields

Route fields are matched against the inbound channel identity:

| Field | Meaning |
|-------|---------|
| `adapterType` | Adapter platform, e.g. `telegram` or `wechat-clawbot`. |
| `chatId` | Platform chat/conversation id. For WeChat ClawBot this is usually `<accountId>/<peerId>`. |
| `authorId` | Platform sender id when available. |
| `accountId` | WeChat ClawBot account id parsed from `<accountId>/<peerId>`. |
| `peerId` | WeChat ClawBot peer id; also matches `authorId` for direct messages. |

Examples:

```json
{ "adapterType": "telegram", "chatId": "-1001234567890" }
{ "adapterType": "telegram", "chatId": "-1001234567890", "authorId": "1124674058" }
{ "adapterType": "wechat-clawbot", "accountId": "d24a7e25e5bd@im.bot" }
{ "adapterType": "wechat-clawbot", "accountId": "d24a7e25e5bd@im.bot", "peerId": "o9cq807H2WYX2riwsrUEKvN1j4QA@im.wechat" }
```

If multiple routes match, Hi-Boss prefers the most specific route. If no route
matches, `ChannelBridge` falls back to the original adapter binding target, so
existing bot behavior continues to work.

#### 3. Check and validate after configuration

Basic agent check:

```bash
hiboss agent list
hiboss agent status --name nex
```

Metadata check:

```bash
hiboss setup export --out /tmp/hiboss-config-check.json
```

Inspect `agents[].metadata.executionLane` in the exported file, then protect or
delete the export because setup export includes adapter binding tokens.

Routing smoke checks:

- Send a normal message from the target Telegram chat/user or WeChat peer and
  confirm it is delivered to the lane speaker instead of the binding fallback.
- Send a channel command such as `/status` or `/new` from the same chat/user and
  confirm the command targets the same lane speaker.
- Use `hiboss envelope thread --envelope-id <id>` on the resulting envelope or
  feedback thread to confirm the recipient agent and the non-secret lane summary
  when it appears in prompt/thread context.

Prompt guidance check:

```bash
npm run prompts:check
```

Then trigger a fresh run for the speaker, or refresh the speaker session if you
need prompt changes to apply immediately:

```bash
hiboss agent refresh --name nex
```

Background cap check, if `backgroundMaxConcurrent` is set:

```bash
# Run these with the lane speaker's agent token, not the boss token.
hiboss envelope send --to agent:background --text "lane background test 1"
hiboss envelope send --to agent:background --text "lane background test 2"
hiboss agent status --name <lane-speaker-name>
```

The status output should show `background-running-count` at or below the lane
limit, with extra work in `background-queued-count`, while the daemon-wide
background concurrency cap still applies.

#### 4. Roll back

Remove the lane by restoring previous metadata, writing metadata without
`executionLane`, or clearing all user metadata:

```bash
hiboss agent set --name nex --metadata-json '{}'
```

or:

```bash
hiboss agent set --name nex --clear-metadata
```

After rollback, the adapter binding remains the default route and channel
messages continue to enter the bound speaker.

#### 5. Current limitations

- There is no dedicated `hiboss lane` CLI; lanes are metadata managed through
  `hiboss agent set --metadata-json` / `--metadata-file`.
- `defaultLeader` and `leaderPool` are prompt guidance for the speaker, not a
  hard routing policy enforced by the daemon.
- `backgroundMaxConcurrent` only limits `agent:background` jobs sent by that
  speaker; it does not limit leader-agent queues.
- Lane metadata is visible to the owning agent's prompt. Never store secrets,
  adapter tokens, iLink bot tokens, QR data, or `context_token` values there.

## `hiboss agent delete`

Deletes an agent.

This removes the agent record, its bindings, its cron schedules, and its home directory under `~/hiboss/agents/<agent-name>/` (or `{{HIBOSS_DIR}}/agents/<agent-name>/` when overridden). It does **not** delete historical envelopes or agent runs (audit log).

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`; boss-privileged token required)

Output (parseable):
- `success: true|false`
- `agent-name:`

## `hiboss agent list`

Lists all agents.

Example:

```bash
hiboss agent list
```

```text
name: nex
role: speaker
workspace: /path/to/workspace
created-at: 2026-02-03T14:22:10-08:00

name: ops-bot
role: leader
created-at: 2026-02-01T09:05:44-08:00
```

Empty output:

```
no-agents: true
```

Output (parseable, one block per agent):
- `name:`
- `role:` (`speaker|leader`)
- `workspace:` (optional)
- `created-at:` (boss timezone offset)

Default permission:
- `restricted`

---

## `hiboss agent refresh`

Requests a fresh provider session for a single agent. Existing/resumed provider session state is cleared; the next run starts from a new session.

Notes:
- Requires a boss token by default (`agent.refresh`).
- The refresh is queued behind any current run for that agent and is applied at the next safe point.
- This is the CLI equivalent of Telegram `/new` for the bound agent, and Telegram `/new <agent-name>` for a named agent.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Example:

```bash
hiboss agent refresh --name kai
```

Output (parseable):
- `success: true|false`
- `agent-name:`

---

## `hiboss agent status`

Shows runtime status for a single agent (intended for operator UX and dashboards).

Notes:
- Requires a token (agent or boss). The output must not include secrets (agent token, adapter token).
- When called with an agent token, only `--name <self>` is allowed (agents cannot query other agents).
- `workspace:` in status is the effective runtime workspace. If unset on the agent record, it falls back to the user's home directory.
- `agent-state` is a **busy-ness** signal: `running` means the daemon currently has a queued or in-flight task for this agent (so replies may be delayed).
- `role:` is shown when available (`speaker` or `leader`).
- `agent-health` is derived from the most recent finished run: `ok` (last run completed or cancelled), `error` (last run failed), `unknown` (no finished runs yet).
- `pending-count` counts **due** pending envelopes (`status=pending` and `deliver_at` is missing or `<= now`).
- `background-*` fields are a live daemon-memory snapshot of `agent:background` jobs delegated by this agent. They are not part of the durable `agent_runs` audit model and reset when the daemon restarts.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`)

Example (with session policy and bindings):

```bash
hiboss agent status --name nex
```

```text
name: nex
role: speaker
workspace: /path/to/workspace
provider: codex
model: default
reasoning-effort: default
permission-level: restricted
bindings: telegram
session-daily-reset-at: 03:00
session-idle-timeout: 30m
session-max-context-length: 180000
agent-state: idle
agent-health: ok
pending-count: 0
background-state: active
background-running-count: 1
background-queued-count: 2
background-open-count: 3
last-run-id: 2b7b6f0b
last-run-status: completed
last-run-started-at: 2026-02-03T12:00:00-08:00
last-run-completed-at: 2026-02-03T12:01:03-08:00
last-run-context-length: 4123
```

Output (parseable):
- `name:`
- `role:` (`speaker|leader` when available; `(missing)` only for broken internal state)
- `workspace:`
- `provider:` (`(none)` when unset)
- `model:` (`default` when unset)
- `reasoning-effort:` (`default` when unset)
- `permission-level:`
- `bindings:` (comma-separated adapter types, or `(none)`)
- `session-daily-reset-at:` (optional)
- `session-idle-timeout:` (optional)
- `session-max-context-length:` (optional)
- `agent-state:` (`running|idle`)
- `agent-health:` (`ok|error|unknown`)
- `pending-count: <n>`
- `background-state:` (`idle|active`)
- `background-running-count: <n>`
- `background-queued-count: <n>`
- `background-open-count: <n>` (`background-running-count + background-queued-count`)
- `current-run-id:` (optional; short id; when `agent-state=running` and a run record exists)
- `current-run-started-at:` (optional; boss timezone offset)
- `last-run-id:` (optional; short id)
- `last-run-status:` (`completed|failed|cancelled|none`)
- `last-run-started-at:` (optional; boss timezone offset)
- `last-run-completed-at:` (optional; boss timezone offset)
- `last-run-context-length:` (optional; integer, when available)
  - Meaning: best-effort **final model-call size** for the last successful run (prompt + output); see `docs/spec/provider-clis.md#token-usage`.
- `last-run-error:` (optional; only when `last-run-status=failed|cancelled`)

---

## `hiboss agent abort`

Cancels the current in-flight run for an agent (best-effort) and clears the agent’s **due** pending inbox.

Notes:
- Intended for operator “stop what you’re doing” moments.
- Cron-generated and future scheduled envelopes are not cancelled.

Flags:
- `--name <name>` (required)
- `--token <token>` (optional; defaults to `HIBOSS_TOKEN`; boss token required)

Output (parseable):
- `success: true|false`
- `agent-name:`
- `cancelled-run: true|false`
- `cleared-pending-count: <n>`
