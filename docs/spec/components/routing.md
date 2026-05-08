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
6. For agent destinations, `deliverToAgent()` triggers the registered handler, which calls `AgentExecutor.checkAndRun(...)`.
7. `AgentExecutor` loads pending envelopes from SQLite, marks them `done` immediately, and runs the agent (at-most-once).

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
