---
id: SM-006
title: Inconsistent lazy-create policy across lifecycle transitions resurrects phantom/removed sessions
angle: state-machine-ux
severity: medium
category: bug
is_workaround: false
subsystem: src-tauri/src/session_projection/store.rs
evidence:
  - src-tauri/src/session_projection/store.rs:436
  - src-tauri/src/session_projection/store.rs:558
  - src-tauri/src/session_projection/store.rs:614
  - src/store/appStore.ts:5801
  - src/components/Terminal/Terminal.tsx:925
status: open
---

## What
The lifecycle store methods use two inconsistent policies for an unknown/removed session id:
- `connect`, `connected`, `dropped`, `reconnect`, `agent_transport_reconnecting`,
  `session_lost`, `set_exit` use `entry().or_insert_with(connecting)` → **lazy-create** a
  `Connecting` record for an unknown id.
- `reconnect_attempt` (`store.rs:436`), `reconnect_failed` (`:452`),
  `set_reconnect_trigger` (`:497`) use `get_mut` → **no-op** for an unknown id.

Because `session.exited`/`dropped` events are dispatched asynchronously
(`Terminal.tsx:925-946`, `appStore.ts:5801-5803` fires `mirrorSessionExited` whenever exit
info is present), an exit or drop that arrives **after** `session.remove` (tab closed)
lazy-creates a ghost entry — a clean exit resurrects a `Disconnected(Normal)` session; a
drop resurrects a `Connecting` one. Conversely a `reconnectAttempt`/`reconnectFailed` that
races ahead of its entry is silently dropped, leaving the loop mid-flight.

## Why it matters
Phantom/stuck session entries appear in the shared region (and thus in any Open-Connections /
session list rendered from it) for tabs the user already closed — an untracked "live" entry
that looks like a leak, or a dropped reconnect attempt that strands the loop. Both are
state-integrity defects that make the session list untrustworthy.

## Evidence
- `store.rs:436-447,452-466,497-502` — `get_mut` no-op branches.
- `store.rs:558-584` — `set_exit` lazy-creates then folds `Disconnected(Normal)`.
- `store.rs:614` — `remove` deletes the entry, which a later async exit/drop can recreate.
- `Terminal.tsx:925-946` — async exit dispatch; `appStore.ts:5801-5803` unconditional
  `mirrorSessionExited`.

## Recommendation
Make the create-vs-noop policy uniform and intent-driven: only `connect` should create an
entry; every post-lifecycle event (`exited`, `dropped`, `reconnect*`, `set_reconnect_trigger`)
should no-op on an unknown/removed id (or explicitly check a tombstone) so a late async event
for a closed tab cannot resurrect a phantom session.
