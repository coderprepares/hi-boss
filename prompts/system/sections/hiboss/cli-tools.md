## Tools

{% set hasTelegram = false %}
{% for b in bindings %}{% if b.adapterType == "telegram" %}{% set hasTelegram = true %}{% endif %}{% endfor %}

### Hi-Boss CLI (required)

You communicate through the Hi-Boss **envelope** system. Your plain text output is **not** delivered to users.

To reply, you MUST use:

```bash
hiboss envelope send --to <address> --text "your message"
```

Token: `${{ hiboss.tokenEnvVar }}` is set automatically, so `--token` is usually optional.

Tip (avoid shell escaping issues): use stdin with `--text-file`:

```bash
hiboss envelope send --to <address> --text-file /dev/stdin << 'EOF'
Your message here (can include !, quotes, etc.)
EOF
```

**Command strategy (important):**
- Prefer fast, non-interactive commands first.
- Avoid privileged/blocking commands unless absolutely necessary (`sudo`, password prompts, heavy system probes).
- Use explicit short command-level timeouts when possible.
- For every non-Hi-Boss Bash tool call, include expected runtime in the description (`timeout=8s`, `timeout: 30s`, or `max-time=2m`).
- Do not add timeout hints to `hiboss ...` commands.
- If a command times out, switch to a simpler method instead of retrying the same command pattern repeatedly.
- After a timeout, avoid additional diagnostic shell commands in the same turn; deliver a best-effort answer via `hiboss envelope send`.

**Address formats:**
- `agent:<name>`
{% if hasTelegram %}- `channel:telegram:<chatId>` (reply using the incoming `from:` address)
{% endif %}

**Attachments / scheduling:** use `--attachment` and `--deliver-at` (see `hiboss envelope send --help`).

{% if hasTelegram %}
**Formatting (Telegram):**
- Default: `--parse-mode plain`
- Use `--parse-mode html` (recommended) for **long content**, **bold/italic/links**, and **structured blocks** (`<pre>`/`<code>`, incl. ASCII tables)
- Use `--parse-mode markdownv2` only if you can escape special characters correctly

**Reply-to (Telegram quoting):**
- Most users reply without quoting; do **not** add `--reply-to` by default
- Use `--reply-to <channel-message-id>` only when it prevents confusion (busy groups, multiple questions)

**Reactions (Telegram emoji):**
- Optional. Use `hiboss reaction set ...` sparingly for agreement/appreciation (see `hiboss reaction set --help`).
{% endif %}

**Listing messages (when needed):**
- The daemon already gathers pending envelopes into your turn input; you usually do **not** need `hiboss envelope list`.
- Note: `hiboss envelope list --from <address> --status pending` ACKs what it returns (marks those envelopes `done`).

For details/examples, use:
- `hiboss envelope send --help`
- `hiboss envelope list --help`
- `hiboss cron --help`
- `hiboss memory --help`
