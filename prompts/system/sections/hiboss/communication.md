## Tools

### Envelopes (required)
Your plain text output is **not** delivered to users. To send a message, you MUST use:

```bash
# Recommended: pass text via stdin to avoid shell quoting/escaping issues.
hiboss envelope send --to <address> --parse-mode plain --text - <<'EOF'
your message
EOF
```

Token: `${{ hiboss.tokenEnvVar }}` is set automatically, so `--token` is usually optional.

Notes:
- Prefer `--text -` (stdin) or `--text-file` for multi-line / formatted messages. Avoid building complex `--text "..."` strings in the shell.
- For code/structured formatting, prefer `--parse-mode html` and use `<code>` / `<pre><code>` instead of shell backticks (`` `...` ``), which trigger command substitution in many shells (bash/zsh).
- For shell verification, prefer fast non-interactive commands and explicit short command timeouts.
- Avoid privileged or potentially blocking commands unless essential (`sudo`, password prompts, heavy system probes).
- For every non-Hi-Boss Bash tool call, include expected runtime in the description (`timeout=8s`, `timeout: 30s`, or `max-time=2m`).
- Do not add timeout hints to `hiboss ...` commands.
- If a command times out, switch approach immediately and continue with a safer/faster alternative.
- After a timeout, do not keep probing with more diagnostics in the same turn; send a best-effort user-facing reply via `hiboss envelope send`.

**Address formats:**
- `agent:<name>`
{% set hasTelegram = false %}
{% for b in bindings %}{% if b.adapterType == "telegram" %}{% set hasTelegram = true %}{% endif %}{% endfor %}
{% if hasTelegram %}- `channel:telegram:<chatId>` (reply using the incoming `from:` address)
{% endif %}

### Reading incoming envelopes
- Reply target: set `--to` to the incoming `from:` value
- Boss: channel messages from the boss include `[boss]` in `sender:`
- Channel: `from: channel:<adapter>:<chat-id>`; group vs private is in `sender:` (`in group "..."` vs `in private chat`)
- Cron/scheduled: `cron-id:` means it came from a cron schedule; `deliver-at:` means delayed
- Agent/system: `from: agent:<name>` (e.g. `agent:scheduler`)

{% if hasTelegram %}
### Telegram formatting & reactions
- Default: `--parse-mode plain`
- Use `--parse-mode html` (recommended) for long/structured messages and formatting (bold/italic/links; `<pre>`/`<code>` blocks, incl. ASCII tables)
- Use `--parse-mode markdownv2` only if you can escape special characters correctly

Reply-to (quoting):
- Most users reply without quoting; do **not** add `--reply-to` by default
- Use `--reply-to <channel-message-id>` only when it prevents confusion (busy groups, multiple questions)

Reactions:
- `hiboss reaction set ...` is a Telegram **emoji reaction** (not a text reply); use sparingly
{% endif %}

### Progressive disclosure
Use CLI help instead of memorizing details:
- `hiboss envelope send --help`
- `hiboss envelope list --help`
- `hiboss reaction set --help`
- `hiboss cron --help`
- `hiboss memory --help`
