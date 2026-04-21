# HTTP Ingress Bridge

Hi-Boss can expose a local HTTP ingress bridge inside the daemon. It accepts authenticated `POST` requests, renders them through a declarative formatter, and materializes the result as a normal envelope.

Key implementation files:

- `src/http-bridge/http-ingress-bridge.ts`
- `src/http-bridge/formatter.ts`
- `src/http-bridge/config.ts`
- `src/daemon/daemon.ts`

## Scope

- This is a local-first bridge that runs inside `hiboss daemon start`.
- It is not a general-purpose workflow engine.
- It is receive-only HTTP ingress. It does not provide HTTP replies from agents or webhook fan-out chains.

## Lifecycle

- The bridge starts and stops with the daemon.
- If no `http-ingress.bridges[]` are configured, no HTTP listener is started.
- The bridge uses one local listener (`host` + `port`) and dispatches by exact request path.

## Request model

- Method: `POST`
- Body: JSON only
- Auth: exact header secret match configured per bridge
- Routing: exact `pathname` match; query strings and fragments are not part of bridge identity

Current guardrails:

- Request bodies larger than 1 MiB are rejected.
- Invalid JSON is rejected.
- Unsupported methods return `405`.

## Bridge config

The declarative setup config (`hiboss setup --config-file`) can include:

- `http-ingress.host`
- `http-ingress.port`
- `http-ingress.bridges[]`

Each bridge defines:

- `name`
- `path`
- `auth.header`
- `auth.secret`
- `target.to`
- `target.sender-agent` when `target.to` is a channel address
- `target.parse-mode` for channel destinations
- `formatter.text`
- `formatter.metadata`
- `formatter.include-raw-body`

Formatter behavior:

- Templates are declarative strings with placeholder interpolation.
- Supported placeholder roots:
  - `json.*` for the parsed request body
  - `bridge.*` for bridge metadata such as `name` and `path`
  - `request.*` for runtime request metadata such as `method`, `path`, and `receivedAt`
- Missing values render as empty strings.
- Non-scalar values render as JSON strings when interpolated into text.
- `formatter.metadata` is rendered recursively; string values are interpolated, non-string scalars are preserved.

## Envelope mapping

### HTTP -> agent

- `from = channel:http:<bridge-name>`
- `to = agent:<configured-agent>`
- `fromBoss = false`
- Replies to this synthetic source are not guaranteed to work; the bridge is intended for inbound events, not conversational HTTP sessions.

### HTTP -> channel

- `from = agent:<target.sender-agent>`
- `to = channel:<adapter>:<chat-id>`
- `target.sender-agent` must already be configured and bound to that adapter type.
- `target.parse-mode` is stored in envelope metadata and reused by normal channel delivery.

## Metadata

Rendered envelopes include a standard metadata block:

```json
{
  "httpBridge": {
    "name": "provider-alerts",
    "path": "/bridges/provider-alerts",
    "method": "POST",
    "receivedAt": "2026-04-21T12:00:00.000Z"
  }
}
```

When `formatter.include-raw-body = true`, the parsed request body is also included under `httpBridge.body`.

## Example

```json
{
  "http-ingress": {
    "host": "127.0.0.1",
    "port": 8787,
    "bridges": [
      {
        "name": "provider-alerts",
        "path": "/bridges/provider-alerts",
        "auth": {
          "header": "X-Bridge-Secret",
          "secret": "replace-me"
        },
        "target": {
          "to": "channel:telegram:-1001234567890",
          "sender-agent": "nex",
          "parse-mode": "html"
        },
        "formatter": {
          "text": "[{json.event}] provider={json.provider.name} state={json.circuit.state}",
          "metadata": {
            "event": "{json.event}",
            "provider": "{json.provider.name}"
          },
          "include-raw-body": true
        }
      }
    ]
  }
}
```

`lite-proxy` is just one possible producer for this bridge shape. Its hook `headers` field can send the configured auth header directly; Hi-Boss does not require a producer-specific integration path.
