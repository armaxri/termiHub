---
id: TAURI-012
title: No authorization on intents / shared-region subscribe (client_id is self-asserted)
angle: backend-tauri-rust
severity: low
category: security
is_workaround: false
subsystem: projection / commands/projection
evidence:
  - src-tauri/src/projection/frame.rs:35
  - src-tauri/src/commands/projection.rs:71
  - src-tauri/src/projection/mod.rs:360
status: open
---

## What

`Intent` carries a `client_id` that is **self-asserted by the caller** (`frame.rs:35`,
"Which attached client dispatched it (fan-out / audit identity)"), and `intent_dispatch` passes
it straight to the dispatcher with no verification (`commands/projection.rs:71`,
`projection/mod.rs:360`). Likewise `projection_subscribe` accepts any `region` +
`subscription_id` + `client_id` from the caller and attaches. There is no check that a client is
permitted to mutate a shared region (e.g. `connections`, `settings`) or that its claimed
`client_id` is its own. On the desktop this is fine — the webview is single-origin and fully
trusted — but the substrate is explicitly designed to also carry these frames over a JSON-RPC
WebSocket in *remote-client mode* (`frame.rs:1-17`, `region.rs` "`<domain>@<clientId>`" scoping,
the `ProjectionSink` "WebSocket send half" doc).

## Why it matters

In remote-client mode the `client_id`/region trust model matters: a connected remote client
could dispatch intents against another client's client-scoped region (`layout@other`) or mutate
shared authority (`settings`, `connections`) if the transport does not enforce identity and
scope above this layer. As written, the substrate itself performs no such enforcement — it
trusts whatever `client_id`/`region` arrive. For the desktop-only release this is not
exploitable; it is flagged so the remote-client work does not inherit an unauthenticated
mutation surface by default.

## Evidence

- `frame.rs:35` — `pub client_id: String` on `Intent`, caller-supplied.
- `commands/projection.rs:71-92` — `intent_dispatch` / `projection_subscribe` forward
  `client_id`/`region` unchecked.
- `projection/mod.rs:222` — `unsubscribe_client` keys purely on the self-asserted `client_id`.

## Recommendation

Keep desktop behaviour as-is (trusted origin), but before enabling remote-client mode, bind
`client_id` to the authenticated transport session (derive it server-side from the connection,
do not trust the field) and add a per-region authorization hook in the dispatcher/subscribe
path (allow-list of regions/intent kinds a given client may touch). Document that the substrate
assumes a trusted `client_id` and that the transport is responsible for authenticating it.
</content>
