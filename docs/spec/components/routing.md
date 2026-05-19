# Routing & Envelope Flow

Hi-Boss routes all messages as **envelopes** through the daemon. The daemon owns persistence and delivery guarantees via SQLite (`~/hiboss/.daemon/hiboss.db`).

Key implementation files:

- `src/daemon/daemon.ts` — wires everything together (IPC, DB, adapters, scheduler, agent execution)
- `src/daemon/bridges/channel-bridge.ts` — converts adapter messages → envelopes
- `src/http-bridge/http-ingress-bridge.ts` — converts local HTTP POSTs → envelopes
- `src/daemon/router/message-router.ts` — creates and delivers envelopes
- `src/daemon/scheduler/envelope-scheduler.ts` — wakes scheduled envelopes and triggers agent runs
- `src/agent/executor.ts` — runs agents and acknowledges envelopes (marks `done` on read)

---

## Components

### Daemon (the orchestrator)

The daemon owns:

- **DB**: agents, bindings, envelopes, agent run audit
- **IPC**: local JSON-RPC over `~/hiboss/.daemon/daemon.sock` (used by `hiboss` CLI)
- **Adapters**: e.g. Telegram bots
- **Routing**: `MessageRouter`
- **Channel bridge**: `ChannelBridge`
- **HTTP ingress bridge**: `HttpIngressBridge`
- **Scheduling**: `EnvelopeScheduler`
- **Agent runtime**: `AgentExecutor`

### Adapters

Adapters provide two main streams into the daemon:

- `ChannelMessage` (chat messages)
- `ChannelCommand` (e.g. Telegram `/new`)

See `docs/spec/adapters/telegram.md`.

---

## Channel Identity Routing & Execution Lanes

Base routing is binding-based: `ChannelBridge` finds the agent bound to the
adapter identity that produced the message. For Telegram, the adapter identity
is the bot token. For WeChat ClawBot, it is the sidecar adapter token. Without
an execution-lane route, all messages from that adapter binding enter the same
target agent.

This means one bot with many users does **not** automatically execute in
parallel. `AgentExecutor` holds a per-agent queue lock, so a single speaker
agent processes one run at a time. Multiple users can enqueue work quickly, but
their AI turns wait behind the same speaker if they share that speaker.

Higher-concurrency deployments can configure an explicit **execution lane**:

```text
channel identity -> speaker agent -> default leader / leader pool -> background limits
```

A lane is the unit of isolation for conversational state, provider sessions,
work queues, and operational ownership. Splitting only the speaker is not always
enough: if several speakers delegate heavy work to the same leader, those heavy
tasks can still queue behind that shared leader. Production deployments that
need isolation should assign both:

- a speaker for the channel/user/account entrypoint;
- a default leader or leader pool for deeper work from that speaker;
- optional background concurrency limits for one-shot delegated tasks.

Execution lane config is stored in speaker agent metadata under
`metadata.executionLane`; no DB schema migration is required. `ChannelBridge`
checks all agents for matching lane routes for both `ChannelMessage` and
`ChannelCommand` inputs before falling back to the adapter binding target. Rule
specificity prefers the most specific match.

Example:

```json
{
  "role": "speaker",
  "executionLane": {
    "id": "wechat-account-a",
    "channelRoutes": [
      {
        "adapterType": "wechat-clawbot",
        "accountId": "account-a"
      }
    ],
    "defaultLeader": "kai-a",
    "leaderPool": ["kai-a", "kai-b"],
    "backgroundMaxConcurrent": 1
  }
}
```

Supported route fields:

| Platform | Stable match fields |
|----------|---------------------|
| Telegram | `adapterType=telegram`, `chatId`, `authorId` |
| WeChat ClawBot | `adapterType=wechat-clawbot`, `chatId`, `accountId`, `peerId`, `authorId` |

Rule specificity should prefer the most specific match:
1. exact user/peer route;
2. exact chat/account route;
3. adapter binding default route.

`adapterToken` is intentionally not part of the metadata route schema because
adapter tokens are credentials. The adapter binding remains the default route
and the internal credential holder. Do not put adapter tokens, bot tokens, iLink
tokens, or `context_token` values in lane metadata because metadata is visible
to the owning agent's prompt.

When a route matches, inbound envelope metadata includes a non-secret
`executionLane` summary (`id`, source, speaker, default leader, leader pool,
background limit). Speaker system prompts also receive the same lane guidance
so P2 delegation prefers lane-local leaders instead of a shared global leader.

`backgroundMaxConcurrent` is enforced by `BackgroundExecutor` per sender agent:
the global background worker limit still applies, but a sender whose execution
lane limit is reached will keep additional `agent:background` jobs queued while
other senders can continue to use available global capacity.

Use multiple adapter bindings when process-level isolation is desired, and
metadata channel routes when one adapter/sidecar should split traffic by stable
chat/user/account identity.

The routing rules are an orchestration feature. They must not move platform
credentials, bot tokens, iLink tokens, or `context_token` values into envelopes
or agent prompts.

---

## Envelope Flow (Inbound)

### Telegram → Agent

1. User sends a message in Telegram.
2. `TelegramAdapter` creates a `ChannelMessage` (text + optional attachments).
3. `ChannelBridge.handleChannelMessage()`:
   - Finds which agent is bound to that bot token (`agent_bindings`)
   - Computes `from-boss` by comparing the sender username with `config.adapter_boss_id_telegram`
   - Creates an envelope:
     - `from = channel:telegram:<chat-id>`
     - `to = agent:<bound-agent-name>`
     - `metadata = { platform, channelMessageId, author, chat }`
4. `MessageRouter.routeEnvelope()` persists the envelope in SQLite (`status = pending`).
5. If the envelope is due now (no `deliver-at`, or `deliver-at <= now`), the router calls `deliverEnvelope()`.
6. For agent destinations, `deliverToAgent()` triggers the registered handler.
7. The daemon applies a short trailing debounce per agent before calling `AgentExecutor.checkAndRun(...)`.
8. `AgentExecutor` loads pending envelopes from SQLite, marks them `done` immediately, and runs the agent (at-most-once).

This debounce is shared by Telegram and WeChat ClawBot because both adapters
produce ordinary channel envelopes before routing. A short burst such as two
Telegram messages or two WeChat messages to the same speaker agent is therefore
processed as one provider turn when the messages land inside the debounce
window. The batching boundary is still the agent: different agents keep
independent timers, and background jobs use the background executor path.

If no binding exists:

- The message is dropped.
- If `from-boss: true`, the adapter receives a “not-configured” message telling you how to bind an agent.

### HTTP ingress → Agent or Channel

1. A local producer sends `POST` JSON to a configured HTTP ingress path.
2. `HttpIngressBridge` validates the auth header and parses the JSON body.
3. The configured formatter renders envelope text and optional metadata.
4. The bridge creates a normal envelope:
   - to an agent via `from = channel:http:<bridge-name>`, or
   - to a channel via `from = agent:<sender-agent>`
5. `MessageRouter.routeEnvelope()` persists and immediately delivers due envelopes using the same routing rules as any other source.

---

## Envelope Flow (Outbound)

### Agent → Telegram

1. Agent sends an envelope using `hiboss envelope send --to channel:telegram:<chat-id> ...`
2. Daemon validates permissions:
   - The sender is the agent identified by the token
   - That agent has a binding for `adapter-type = telegram`
3. `MessageRouter.routeEnvelope()` persists the envelope.
4. If due now, the router calls `deliverToChannel()`:
   - Looks up the adapter by binding token
   - Resolves optional reply quoting from `metadata.replyToEnvelopeId` only (same adapter + same chat + referenced `channelMessageId` required)
   - Ignores legacy direct reply-id metadata (`metadata.replyToMessageId`) when present
   - Calls `adapter.sendMessage(chatId, { text, attachments }, { replyToMessageId? })`
   - On success, sets `status = done`

---

## Scheduled Delivery

Scheduled delivery uses the same envelope record, but delays actual delivery until `deliver-at` is due.

- When an envelope is created with a future `deliver-at`, the router stores it as `pending` and does not deliver it immediately.
- `EnvelopeScheduler` wakes up at the next scheduled time and:
  - delivers due channel envelopes (via `router.deliverEnvelope(...)`)
  - triggers agent runs for agents with due envelopes (via `executor.checkAndRun(...)`)

See `docs/spec/components/scheduler.md` for the exact wake-up algorithm.

### WeChat ClawBot Sidecar → Agent

The WeChat ClawBot adapter follows the same envelope semantics as Telegram but
uses a local sidecar contract for personal-WeChat ClawBot / OpenClaw weixin
runtime isolation.

See `docs/spec/adapters/wechat-clawbot.md`.

---

## `/new` Session Refresh (Telegram)

1. Boss sends `/new` or `/new <agent-name>` to the Telegram bot.
2. `TelegramAdapter` emits a `ChannelCommand { command: "new", ... }`.
3. `ChannelBridge` enforces boss-only behavior and resolves which agent is bound to that bot token:
   - if unbound: returns a `not-configured:` + `fix:` message
   - if bound: enriches the command with `agentName`
4. `Daemon` receives the bound command and resolves the target:
   - without args: the bound agent
   - with one arg: the named agent
5. `Daemon` calls `AgentExecutor.requestSessionRefresh(targetAgentName, "telegram:/new")` and returns `Session refresh requested.`
   - when the named target differs from the bound agent, the reply also includes `agent-name: <name>`
6. `TelegramAdapter` replies with the returned message.
7. The refresh is applied at the next safe point (before the next run, or after the current queue drains).

---

## `/status` (Telegram)

1. Boss sends `/status` or `/status <agent-name>` to the Telegram bot.
2. `TelegramAdapter` emits a `ChannelCommand { command: "status", ... }`.
3. `ChannelBridge` enforces boss-only behavior and resolves which agent is bound to that bot token:
   - if unbound: returns a `not-configured:` + `fix:` message
   - if bound: enriches the command with `agentName`
4. `Daemon` computes the status for the bound agent by default, or for the named agent when one arg is provided, and returns the same key/value output as `hiboss agent status --name <agent-name>`, including live background delegation counts.
5. `TelegramAdapter` replies with the returned status text.

## `/help` (channel adapters)

1. Boss sends `/help` to a supported chat adapter.
2. The adapter emits a `ChannelCommand { command: "help", ... }`.
3. `ChannelBridge` enforces boss-only behavior and resolves the bound/lane agent.
4. `Daemon` replies with the commands supported by that adapter.
