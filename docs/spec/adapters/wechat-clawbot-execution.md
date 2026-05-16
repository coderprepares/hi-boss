# WeChat ClawBot Execution Model

The sidecar can hold multiple iLink bot accounts in one local process. Account
state is isolated by `account_id`:
- each account has its own bot token indirection;
- each account has its own persisted `get_updates_buf`;
- peer context tokens, reply-window expiry, and pending outbound queues are
  keyed by `account_id + peer_id`;
- outbound replies always include the target `account_id` and `peer_id`, so
  messages are not sent through the wrong bot account.

This account isolation does **not** automatically imply independent AI
execution. The execution model depends on how adapter bindings are assigned.
Use the execution-lane model in `docs/spec/components/routing.md`: a production
lane should include the channel/account route, speaker agent, and default
leader or leader pool. Splitting only the speaker can still bottleneck deeper
work if all speakers delegate to the same leader.

- **Single adapter binding to one speaker agent** — all account traffic enters
  the same speaker. This keeps deployment simple, but agent runs queue behind
  that speaker; a long task for account A can delay account B.
- **One adapter binding per account/sidecar, each bound to a different speaker
  agent and leader lane** — execution can proceed in parallel because each
  lane has its own speaker queue, provider session, and leader/delegation path.
  This is the recommended first production shape for multiple accounts.
- **Future account-aware dispatch** — one sidecar could expose all accounts
  while Hi-Boss routes by `account_id` or `account_id + peer_id` to different
  execution lanes. This would require explicit routing configuration and is not
  part of the MVP adapter.

The current in-repo sidecar polls accounts sequentially. This is acceptable for
MVP because iLink polling is lightweight. If account count or network latency
becomes material, sidecar polling can be changed to per-account concurrent
polling without changing the `channel:wechat-clawbot:<account-id>/<peer-id>`
address contract. The larger user-visible bottleneck is usually the AI
execution queue, not sidecar polling.

Recommended multi-account rollout:
1. Start with one WeChat bot account per speaker agent when parallel execution
   matters.
2. Use separate sidecar configs, ports, state files, and PM2 process names for
   strong operational isolation.
3. Bind each speaker to only its own sidecar adapter token, and assign a
   separate default leader or leader pool if deeper work must not queue behind
   another account's work.
4. Add dynamic account-aware dispatch only after the simple per-account lane
   layout becomes operationally inconvenient.
