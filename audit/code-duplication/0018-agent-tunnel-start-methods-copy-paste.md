---
id: DUP-018
title: Agent tunnel start_local/start_remote/start_dynamic are ~90% copy-paste
angle: code-duplication
severity: medium
category: arch
is_workaround: false
subsystem: agent/tunnel/mod.rs
evidence:
  - agent/src/tunnel/mod.rs:126
  - agent/src/tunnel/mod.rs:149
  - src-tauri/src/tunnel/tunnel_manager.rs:1097
status: open
---

## What

The agent's `start_local` / `start_remote` / `start_dynamic` are ~90% copy-paste of each other:
duplicate-key precheck, `connect_and_authenticate`, start the forwarder,
`bound_address = format!("{host}:{port}")`, `classify_reachability`, re-check under lock, insert. The
`format!` bound-address + classify block is repeated three times. The desktop performs the same
"connect → start → classify → record" ceremony in `build_forwarder` (matched over `TunnelType`).

## Why it matters

Three copies of the same start ceremony in the agent invite one being fixed and the others not (the
race-recheck comment, error handling, reachability classification). Medium — it is orchestration
around the correctly-shared core forwarders.

## Evidence

- `agent/src/tunnel/mod.rs:126-291` — `start_local`/`start_remote`/`start_dynamic`; the
  bound-address + classify block repeated at `:149-150`, `:210-211`, `:269-270`.
- `agent/src/handler/dispatch.rs:1620-1628` — dispatch to the three.
- `src-tauri/src/tunnel/tunnel_manager.rs:1097-1124` — desktop `build_forwarder` (parallel shape).

## Recommendation

Collapse the three agent methods into one `start(spec: &TunnelForwardSpec, …)` that matches
internally, and lift a small `core::tunnel` helper for "build bound_address + classify_reachability
from a bind host" shared by both the agent and the desktop start paths.
