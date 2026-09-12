---
id: DUP-020
title: The "desktop controls a service on a remote agent" control layer is copy-pasted across three managers
angle: code-duplication
severity: high
category: reliability
is_workaround: false
subsystem: src-tauri/embedded_servers, src-tauri/network, src-tauri/tunnel
evidence:
  - src-tauri/src/embedded_servers/server_manager.rs:732
  - src-tauri/src/network/mod.rs:915
  - src-tauri/src/tunnel/tunnel_manager.rs:989
status: open
---

## What

The plumbing for "the desktop hosts/controls a Service running on a remote agent" — a per-agent
handle map, an idempotent self-reaping status poller, a broadcast→Tauri event bridge, and the
`json!({instanceId,...})` RPC param builders — is independently reimplemented three times, nearly
verbatim, across the embedded-servers manager, the HTTP-monitor host, and the tunnel manager.
`spawn_event_bridge` in `server_manager.rs` and `network/mod.rs` are structurally identical (same
`recv().await` loop, same `RecvError::Lagged(_) => continue` / `Closed => break` contract, differing
only in the event-kind constant and Tauri event name).

## Why it matters

This is subtle concurrency code — poller self-reap, broadcast-lag handling, "snapshot targets under
lock then release before RPC." A fix to one (e.g. a poller leak or a lag-drop bug) will not
propagate to the other two. High divergence risk because the bug classes here are exactly the ones
that are hard to spot in review and expensive in production (leaked pollers, missed events).

## Evidence

- `src-tauri/src/embedded_servers/server_manager.rs` — `AgentServerHandle` :65; `STATUS_POLL_INTERVAL`
  :56; `ensure_agent_status_poller` :470; `spawn_event_bridge` :732; `poll_agent_server_states` :699.
- `src-tauri/src/network/mod.rs` — `AgentMonitorHandle` :53; `AGENT_STATUS_POLL_INTERVAL` :36;
  `ensure_agent_status_poller` :460; `spawn_event_bridge` :915.
- `src-tauri/src/tunnel/tunnel_manager.rs` — `AgentTunnelHandle` :366; `agent_stats_poller` :425;
  `ensure_agent_stats_poller` :989.

## Recommendation

Extract a generic `AgentHostedServices<H>` helper (handle map + `ensure_status_poller` +
`spawn_event_bridge` + param builders), parameterized by the `service.*` method names and a
state-parse closure. It must live in `src-tauri` (it needs `AppHandle` + `AgentRpcClient`, which
`core` cannot see) — e.g. alongside the existing `RunLocationResolver`. Highest-value fix in the
service-hosting area.
