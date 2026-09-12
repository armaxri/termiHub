---
id: OBS-012
title: Agent cross-desktop session eviction/reclaim has no diagnostic log
angle: observability
severity: medium
category: reliability
is_workaround: false
subsystem: agent/src/session/manager.rs, agent/src/client_registry.rs
evidence:
  - agent/src/session/manager.rs
  - agent/src/client_registry.rs
status: fixed
resolution: "#2801 — decide_attach WARN/INFO logging of eviction/takeover/refused-recovery + client registry"
---

## What
Another expert found that agent sessions can be silently evicted/reclaimed when a session is
taken over across desktops (multi-client / cross-desktop persistence). Searching the agent
session manager and client registry for eviction/reclaim/reap/detach logging
(`agent/src/session/manager.rs`, `client_registry.rs`) returns **no** `info!`/`warn!` lines
for that path. Combined with OBS-003 (the agent has no durable log and daemon/listen stderr
never reaches the desktop), an eviction event is doubly invisible: it isn't logged, and even
if it were, the sink wouldn't reach support.

## Why it matters
"My session just disappeared" is precisely the kind of failure field logs exist to explain.
When the agent evicts a session because another client/desktop took it over (or a lease
expired), that should be an INFO/WARN event naming which session, which client won, and why.
Today it happens with no record on either side, so a supporter cannot distinguish a
deliberate takeover from a crash or a network drop.

## Evidence
No eviction/reclaim/reap logging in `agent/src/session/manager.rs` or
`agent/src/client_registry.rs` (grep for `evict|reclaim|reap|expire|orphan|detach|drop|close`
against `info!|warn!` returns nothing). Contrast the desktop-side reconnect path
(`agent_manager.rs:2248-2311`), which logs its lifecycle transitions.

## Recommendation
Log every session ownership transition on the agent at INFO/WARN with structured fields
(`session_id`, evicting `client_id`, reason), and emit a corresponding event the desktop can
surface to the user ("this session was taken over by another connection"). This depends on
OBS-003 (durable agent log) to be retrievable and OBS-004 (correlation id) to line up with
the desktop's view. Verify the specific eviction call site with the concurrency/state-machine
experts to place the log lines precisely.
