---
id: ARCH-003
title: Two parallel state mechanisms coexist — projection substrate never displaced the typed command/event surface
angle: architecture-overall
severity: medium
category: arch
is_workaround: false
subsystem: src-tauri/src/commands, src/store, src-tauri/src/projection
evidence:
  - src-tauri/src/lib.rs:1322
  - src/services/api.ts:1
  - src-tauri/src/projection/mod.rs:15
status: open
---

## What

The stateless-UI projection substrate (#2139/#2149) was introduced as a
**strangler migration**: server-authoritative per-region versioned diff channels
meant to progressively replace the ~206 typed Tauri commands and ~36 events. The
substrate's own doc says the two generic channels "land **beside** the existing
~206 typed commands and ~36 events (strangler migration)"
(`projection/mod.rs:15-20`).

The migration mirrored 11 domains onto regions and removed the frontend
*reducers*, but it did **not** remove the underlying typed command/event surface:

- `generate_handler![…]` still registers **~206 commands** (`lib.rs:1322-1633`).
- `src/services/api.ts` still wraps **~203 `invoke(...)` calls** (2472 lines).
- Every migrated domain now has BOTH a region (`*_projection` in the backend,
  `*Bridge.ts` + `useProjected*` in the frontend) AND its original commands/
  events, because intents mutate authoritative state that is still persisted and
  read through the old command paths.

So the app runs two state-transport architectures at once — the mature typed
IPC layer and the projection layer stacked on top of it — indefinitely, with no
scheduled convergence on one.

## Why it matters

- **Cognitive load / coherence:** a contributor must understand *both* systems
  and, per domain, know which one is authoritative for a given piece of state.
  The projection layer added ~10 backend `*_projection` modules + ~10 frontend
  `*Bridge.ts` + ~10 `useProjected*` hooks *without deleting* the layer beneath.
- **Two sources of truth to keep in sync:** the region snapshot must be folded
  from the same authority the commands mutate (`seed_agents_from_manager`,
  `fold_connections_from_manager`, etc. in `lib.rs`), so every mutation now has
  to update two views. Divergence between them is a latent correctness bug
  class on a safety-critical UI.
- This is the largest single structural change in the codebase and it is
  half-landed: the *benefit* (delete the reducers, one authoritative writer) was
  only partly realized while the *cost* (a second full mechanism) is fully paid.

## Evidence

- `src-tauri/src/projection/mod.rs:15-20` — the strangler intent, stated.
- `src-tauri/src/lib.rs:1322-1633` — ~206 typed commands still registered.
- `src/services/api.ts` — 203 `invoke` wrappers still in use.
- `src-tauri/src/lib.rs:971-1040` — region seeds fold from the *same*
  `ConnectionManager` authority the typed commands mutate (dual maintenance).

## Recommendation

Make a decision and write it down as an ADR: either (a) finish the strangler —
pick the highest-traffic domains, move their persistence + mutation fully behind
intents, and delete the corresponding commands/events; or (b) formally scope the
projection substrate to the domains that benefit from multi-subscriber fan-out
(multi-window, remote client) and stop migrating the rest, documenting the typed
command layer as the permanent primary. Shipping "both, forever, undecided" is
the worst of the three for a maintainability/safety bar. Track a per-domain
"commands retired" column so the migration has a definition of done.
