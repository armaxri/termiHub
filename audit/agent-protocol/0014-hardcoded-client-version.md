---
id: AGT-014
title: Desktop reports a hardcoded clientVersion "0.1.0" in initialize — client-version tracking and the update guard are meaningless
angle: agent-protocol
severity: low
category: bug
is_workaround: false
subsystem: src-tauri/src/terminal/agent_manager.rs
evidence:
  - src-tauri/src/terminal/agent_manager.rs:1752
status: open
---

## What
`build_initialize_params` hardcodes `clientVersion: "0.1.0"`
(`src-tauri/src/terminal/agent_manager.rs:1752`) rather than reporting the desktop's real
application version. The agent records this in its per-process `ConnectionRegistry` and
echoes it via `agent.list_connections` (the connected-host update guard, #1349). Every
connected client therefore appears as version `0.1.0`.

## Why it matters
`agent.list_connections` exists to let a desktop see which other clients are attached before
it triggers a host-wide agent update (AGT-003). Any version-based reasoning or display
built on that data is meaningless because the field is a constant. It is also a
maintainability trap: it looks like real telemetry but is a literal.

## Evidence
- `src-tauri/src/terminal/agent_manager.rs:1752` — `clientVersion: "0.1.0"` literal (same
  block that pins `protocolVersion: "0.3.0"`, see AGT-010).

## Recommendation
Report the desktop's actual version (`env!("CARGO_PKG_VERSION")` or the Tauri app version)
in `clientVersion`.
