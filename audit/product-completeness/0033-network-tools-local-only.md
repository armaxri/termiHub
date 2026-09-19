---
id: PROD-033
title: Ping-sweep, open-ports, and HTTP monitor cannot run from a remote agent
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: core/network, src/components/NetworkTools, agent
evidence:
  - src/components/NetworkTools/networkToolLocation.ts:32
  - src-tauri/src/commands/network.rs:482
status: open
---

## What
Ping-sweep and open-ports are local-only (`agentAllowed: false`, run-location offers only
"This computer"); the HTTP monitor is also desktop-only (the agent has no HTTP-monitor method).
Ping/traceroute/port-scan/DNS/WoL do support agent execution.

## Why it matters
Sweeping a remote subnet or listing open ports/monitoring an endpoint from the agent's network
vantage point is a key reason to have an agent. These three tools can only see the desktop's
own network.

## Evidence
- `src/components/NetworkTools/networkToolLocation.ts:32-34` — `http-monitor`, `ping-sweep`, `open-ports` `agentAllowed:false`.
- `src-tauri/src/commands/network.rs:482-483` (open-ports no agent path), `:302-379` (sweep no agent routing).

## Recommendation
Add agent RPC methods for ping-sweep, open-ports, and HTTP monitor so they can run remotely,
matching the other network tools.
