---
id: SM-013
title: Pause on an agent-hosted system monitor is a silent no-op that desyncs the UI
angle: state-machine-ux
severity: medium
category: bug
is_workaround: true
subsystem: src-tauri/src/session/remote_proxy.rs + src-tauri/src/commands/session.rs
evidence:
  - src-tauri/src/session/remote_proxy.rs:752
  - src-tauri/src/commands/session.rs:748
  - src-tauri/src/system_monitor_projection/store.rs:184
status: open
---

## What
For an agent-hosted system monitor, `remote_proxy.rs` `set_paused` is a `debug!` stub
(`:752-769`) that does not actually pause collection. But `commands/session.rs:748-763`
unconditionally folds `store.set_paused` into the authoritative region (`:761`), and
`store.stats()` (`system_monitor_projection/store.rs:184-191`) has no paused-guard on the
sample stream.

## Why it matters
The user clicks Pause on an agent-hosted monitor and gets a success toast plus a "Paused"
badge (`StatusBar.tsx:790-799`) while the numbers **keep visibly ticking**. The displayed
state (Paused) contradicts the observed behavior (still updating) — an ambiguous, self-
contradicting status. Reproducible on any agent-hosted monitor. Marked `is_workaround: true`
because the pause path is a stub the region pretends succeeded.

## Evidence
- `remote_proxy.rs:752-769` — `set_paused` is a no-op stub.
- `commands/session.rs:748-763` — folds `set_paused` into the region regardless of outcome.
- `system_monitor_projection/store.rs:184-191` — `stats()` has no paused guard.

## Recommendation
Either implement pause on the agent path (stop the collect loop / suppress samples), or —
until then — reject/disable Pause for agent-hosted monitors so the region never claims a
Paused state the backend cannot honor.
