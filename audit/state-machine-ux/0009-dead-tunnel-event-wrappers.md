---
id: SM-009
title: Dead tunnel event wrappers left by the projection migration (legibility trap)
angle: state-machine-ux
severity: low
category: workaround
is_workaround: true
subsystem: src/services/events.ts
evidence:
  - src/services/events.ts:607
  - src/store/slices/tunnelSlice.ts:157
status: open
---

## What
After the tunnel projection migration (#1141/#2150), the tunnel UI is driven by a projection
region subscription (`tunnelSlice.ts:157-166`). The old frontend event wrappers
`onTunnelStatusChanged` / `onTunnelStatsUpdated` (`services/events.ts:607-627`) still exist
but have **zero consumers** (confirmed by grep). The Rust side still emits
`tunnel-stats-updated` (`tunnel_manager.rs:958`) that nothing on the frontend listens to.

## Why it matters
No runtime effect, but this is dead code left over from a half-completed migration — it
"looks wired" and will mislead a future maintainer reasoning about tunnel state flow (is the
UI event-driven or region-driven?). Per the audit's workaround mandate, migration residue
should be removed before release.

## Evidence
- `services/events.ts:607-627` — `onTunnelStatusChanged`/`onTunnelStatsUpdated`, no callers.
- `tunnel_manager.rs:958` — emits `tunnel-stats-updated` with no frontend consumer.

## Recommendation
Delete the unused event wrappers and, if nothing else consumes it, the backend
`tunnel-stats-updated` emit; the projection region is the single source of tunnel state.
