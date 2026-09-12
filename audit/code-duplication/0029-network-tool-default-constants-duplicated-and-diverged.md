---
id: DUP-029
title: Network-tool default parameter values are duplicated across three wrappers and already diverge
angle: code-duplication
severity: medium
category: bug
is_workaround: false
subsystem: core/tool, agent/network, src-tauri/commands
evidence:
  - src-tauri/src/commands/network.rs:344
  - core/src/tool/network_tools.rs:145
  - agent/src/network/mod.rs:28
status: open
---

## What

Per-tool default values are hardcoded independently at each of the three wrapper sites (DUP-027):
port-scan timeout `2000` / concurrency `100`, ping interval `1000`, traceroute max_hops `30`, WoL
port `9`. They have **already diverged**: ping-sweep concurrency is `64` on the desktop but `100` in
the core registry (which reuses `default_scan_concurrency`).

## Why it matters

`category: bug` — the same tool run locally vs on an agent uses different defaults (sweep
concurrency 64 vs 100), a user-observable behavior difference that is purely an artifact of copied
constants drifting. Medium.

## Evidence

- Port-scan timeout/concurrency: `agent/src/network/mod.rs:28-29`,
  `src-tauri/src/commands/network.rs:126-127`, `core/src/tool/network_tools.rs:93-98`.
- Ping interval `1000`: `agent/src/network/mod.rs:57`, `src-tauri/src/commands/network.rs:249`,
  `core/src/tool/network_tools.rs:45`.
- Traceroute max_hops `30`: three sites likewise.
- **Diverged:** ping-sweep concurrency `src-tauri/src/commands/network.rs:344` = `64` vs
  `core/src/tool/network_tools.rs:145` = `100`.

## Recommendation

Define the defaults as `pub const` in the relevant `core::network` modules, consumed everywhere.
Naturally subsumed if DUP-027 routes all callers through the single `core::tool::ToolRegistry`.
