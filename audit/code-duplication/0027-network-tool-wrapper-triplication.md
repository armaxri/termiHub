---
id: DUP-027
title: Network tools are wrapped as invokable tools in three parallel layers (agent exposes them twice)
angle: code-duplication
severity: medium
category: arch
is_workaround: false
subsystem: core/tool/network_tools.rs, agent/network/mod.rs, src-tauri/commands/network.rs
evidence:
  - core/src/tool/network_tools.rs:357
  - agent/src/network/mod.rs
  - src-tauri/src/commands/network.rs:66
status: open
---

## What

The seven core network tools (ping, port-scan, ping-sweep, traceroute, DNS, open-ports, WoL) are
each wrapped by hand in three independent places, each doing its own param-decode / default-
application / result-streaming around the identical `core::network` calls:

1. `core::tool::network_tools` — the `Tool`-trait registry, wired into the agent's `tool.*` RPC.
2. `agent::network::mod` — `handle_*` fns wired into the **legacy `network.*` RPC**.
3. `src-tauri::commands::network` — the desktop local path (which does **not** use the core
   `ToolRegistry` at all).

Notably the **agent exposes the same tools twice** — via `network.*` (its hand wrappers) and `tool.*`
(the core registry). Asymmetry already exists (agent `network.*` lacks ping-sweep; the registry and
desktop have it).

## Why it matters

Three wrapper surfaces mean three copies of the defaults (DUP-029) and three DNS parsers (DUP-028),
and two RPC method families exposing the same functionality on the agent. The actual tool
implementations and result types ARE correctly centralized in `core::network` — this is all in the
adapter layer. Medium: divergence is real (missing ping-sweep, differing defaults) but not
safety-critical.

## Evidence

- `core/src/tool/network_tools.rs:357` — `builtin_network_tools()`; wired at
  `agent/src/handler/dispatch.rs:169`, dispatched `:1457-1483`.
- `agent/src/network/mod.rs` — `handle_port_scan`/`handle_ping`/… wired at
  `agent/src/handler/dispatch.rs:1360-1442`.
- `src-tauri/src/commands/network.rs:66` (`network_port_scan`) and siblings `:202/:303/:448/:483/
  :497/:586`.

## Recommendation

Converge on the existing `core::tool::ToolRegistry` (already the agent's `tool.*` backend): make the
desktop `commands::network` local branches and the agent's `network.*` methods thin transport
adapters over the registry, or deprecate `network.*` in favor of `tool.*`. Removes the second agent
surface and collapses DUP-028/DUP-029.
