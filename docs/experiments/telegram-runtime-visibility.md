# Telegram Runtime Visibility Notes

This document records manual investigation notes for Telegram-side runtime visibility and background-agent observability.

Specs remain canonical in:
- `docs/spec/adapters/telegram.md`
- `docs/spec/components/agent.md`
- `docs/spec/provider-clis.md`

## Test date

- 2026-04-19

## Scope

These notes capture implementation decisions and observed provider CLI behavior that informed the current Telegram visibility work. They are descriptive, not normative.

## Findings

### 1. Do not directly port the older verbose/status implementation

The older fork relied on a different runtime-event shape. Current Hi-Boss foreground execution streams provider CLI JSON output directly from `src/agent/executor-turn.ts`, and Telegram status rendering now consumes that live JSONL stream via `src/daemon/telegram-verbose.ts`.

Practical implication:
- Reusing old assumptions like dedicated thinking/tool-call deltas would be brittle.
- The current implementation should continue to follow the event types actually emitted by the provider CLI.

### 2. Current Codex JSONL events are sufficient for a compact first step

Manual sampling of `codex exec --json` during real runs showed a stable-enough minimal shape for Telegram status updates:
- `thread.started`
- `turn.started`
- `item.started`
- `item.completed`

Observed item payloads useful to Telegram status rendering:
- `item.type = "command_execution"`
- `item.type = "agent_message"`

This matches the parser assumptions in:
- `src/agent/provider-cli-parsers.ts`
- `src/daemon/telegram-verbose-utils.ts`

Practical implication:
- A compact execution trace can be built from lifecycle events, command start/completion, and assistant preview text.
- This is intentionally narrower than a full internal run tree and should not be treated as an exhaustive model of all Codex runtime activity.

### 3. OpenCrust comparison supports a single-message status design

The OpenCrust comparison used during investigation showed a simpler pattern:
- keep Telegram `typing` active while work is running
- edit a single Telegram message in place for status

It does not provide the richer multi-stream UI that existed in older experiments/forks.

Practical implication:
- Hi-Boss should keep the first step minimal and operator-friendly: one status message with compact history, plus normal final reply delivery.

### 4. Current Hi-Boss Telegram behavior

Current minimal Telegram runtime visibility is split into two layers:

- Base behavior:
  - Telegram `typing` is sent for Telegram-originated bound-agent runs.
- Verbose behavior:
  - `/verbose on` enables a single status message for the current chat.
  - The status message shows compact lifecycle history, command execution summaries, and assistant preview text.

This separation is implemented in `src/daemon/telegram-verbose.ts` and documented canonically in `docs/spec/adapters/telegram.md`.

Practical implication:
- `typing` is an always-on liveness hint for Telegram runs.
- `/verbose` controls status-message visibility only; it should not gate `typing`.

### 5. Background agent observability is still minimal

Current background jobs (`to: agent:background`) are daemon-executed one-shot tasks:
- queue + execution flow: `src/agent/background-executor.ts`
- provider process spawning + final-text extraction: `src/agent/background-turn.ts`

Observed current behavior:
- daemon logs `background-job-start`
- daemon logs `background-job-complete`
- sender receives only the final feedback envelope
- no persistent conversational run model
- no Telegram live status updates for background jobs

Practical implication:
- Background jobs are currently suitable for fire-and-forget subtasks, not interactive runtime inspection.
- A minimal future step would be explicit started/completed/failed feedback for background jobs.
- Rich live visibility for background jobs would require larger architecture work than the current foreground Telegram status path.

## Current direction

The current chosen direction is:
- keep Telegram runtime visibility grounded in the current provider CLI JSON stream
- keep `/verbose` lightweight and chat-scoped
- keep `typing` independent from verbose status rendering
- avoid overfitting to older event models that no longer match current Codex behavior
