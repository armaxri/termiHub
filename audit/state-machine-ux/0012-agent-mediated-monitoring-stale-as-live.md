---
id: SM-012
title: Agent-mediated system monitoring shows stale data as live forever (no Stale/Reconnecting/Offline)
angle: state-machine-ux
severity: high
category: bug
is_workaround: true
subsystem: src-tauri/src/session/remote_proxy.rs
evidence:
  - src-tauri/src/session/remote_proxy.rs:682
  - src-tauri/src/session/remote_proxy.rs:707
  - core/src/monitoring/status.rs:23
status: open
---

## What
The direct-SSH system-monitoring path has a full status machine
(`Connecting → Live → Stale → Reconnecting → {Live|Offline}`, `core/src/monitoring/status.rs`).
The **agent-mediated** path does not: `remote_proxy.rs` `subscribe()` sends exactly one
hardcoded `MonitorStatus::Live` (`:707-708`) and never updates it. An in-code comment
(`:701-706`) admits this is a deferred follow-up. `set_paused`/`cancel_connect` are `debug!`
stubs (`:752-769`).

## Why it matters
For any system monitor routed through an agent (#2593), a mid-stream transport drop **freezes
the CPU/mem/disk numbers with no visible change** — the status stays `Live`, so the dimming/
Stale/Reconnecting/Offline machinery never engages and stale data reads as live
**permanently**. This is the old spec G1 (data-integrity: stale data shown as live) reborn on
the newer agent code path, and it is on the monitoring surface the "ventilator-grade"
philosophy most needs to be truthful. Marked `is_workaround: true` because the code itself
documents it as a deferred stub, not a finished state machine.

## Evidence
- `remote_proxy.rs:707-708` — hardcoded single `MonitorStatus::Live`, never updated.
- `remote_proxy.rs:701-706` — comment admitting deferred follow-up.
- `remote_proxy.rs:752-769` — `set_paused`/`cancel_connect` are no-op stubs.
- `core/src/monitoring/status.rs:23-40` — the real machine the direct path uses.

## Recommendation
Drive the same `MonitorStatus` machine (Live/Stale/Reconnecting/Offline) from the
agent-mediated path: propagate transport drops from the agent I/O layer into the monitor
status so stale samples dim and reconnect/offline are visible, matching the direct-SSH path.
