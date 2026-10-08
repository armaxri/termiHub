---
id: PERF2-007
title: "Tunnel live-stats still double-emit: legacy tunnel events with no listener at 1 Hz, plus a full tunnels-region rebuild"
angle: performance
severity: low
category: perf
is_workaround: true
subsystem: src-tauri/src/tunnel
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - src-tauri/src/tunnel/tunnel_manager.rs:257
  - src-tauri/src/tunnel/tunnel_manager.rs:1143
  - src-tauri/src/tunnel/tunnel_manager.rs:1149
  - src-tauri/src/tunnel/tunnel_manager.rs:1774
  - src-tauri/src/tunnel/projection.rs:244
---

## What

While any tunnel is active, the stats task emits a legacy `tunnel-stats-updated` event per tunnel every second (1143), a global broadcast to every window. It then publishes the `tunnels` projection region (1149), which rebuilds and re-serializes the whole tunnel view and structurally diffs it (`publish_with(TUNNELS_REGION, build_tunnel_view)`, projection.rs:244). The frontend has no listener for `tunnel-stats-updated`, and none for `tunnel-status-changed` (1774): neither event name appears anywhere under src/. This is the same dual-write PERF-007 removed for monitoring stats, still present on the tunnel path.

## Why it matters

While a tunnel is up, the app serializes and broadcasts IPC traffic every second that nothing consumes. The cost is small in absolute terms because tunnel counts are low, but it is pure waste on a steady timer, and the dead events make it look as if a consumer exists.

## Evidence

- `src-tauri/src/tunnel/tunnel_manager.rs:257`
- `src-tauri/src/tunnel/tunnel_manager.rs:1143`
- `src-tauri/src/tunnel/tunnel_manager.rs:1149`
- `src-tauri/src/tunnel/tunnel_manager.rs:1774`
- `src-tauri/src/tunnel/projection.rs:244`

## Recommendation

Delete the `tunnel-stats-updated` and `tunnel-status-changed` emits now that the `tunnels` region is the only consumer. Keep the projection publish, and optionally switch the region to `publish_delta` on the stats fields, as #2878 did for the other hot regions.

## Verification

Confirmed. The stats emitter still calls `app_handle.emit(TUNNEL_STATS_EVENT, update)` every second per tunnel, then calls publish_tunnels, which runs publish_with(build_tunnel_view). Line 1774 still emits 'tunnel-status-changed'. A grep of the whole repo outside node_modules and target finds no frontend consumer, only docs and the backend. Prior audit SM-009 (#2891) removed only the frontend wrappers and left these backend emits, so this is residue from that fix rather than a fully new finding. Its doc comment still points to an onTunnelStatsUpdated listener that no longer exists.
