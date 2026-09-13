---
id: TAURI-006
title: Half-migrated projection architecture — 9/11 domains shadow, dual authority + dual-write
angle: backend-tauri-rust
severity: high
category: arch
is_workaround: true
subsystem: projection / *_projection
evidence:
  - src-tauri/src/lib.rs:768
  - src-tauri/src/lib.rs:883
  - src-tauri/src/connections_projection/projection.rs:44
  - src-tauri/src/connections_projection/projection.rs:116
  - src-tauri/src/commands/connection.rs:56
status: open
---

## What

The stateless-UI projection substrate is a strangler migration that is shipping **mid-flight**.
Per the `lib.rs` `setup()` wiring and the module docs, of the 11 projected domains only a few
actually drive the UI (broadcast, restore-cohort, and the tunnels pilot). The rest —
`agents`, `connections`, `settings`, `transfers`, `system-monitors`, `file-browser`,
`workflow-run`, `session-lifecycle`, `layout` — are explicitly **shadow**: registered, seeded
at startup, and folded on every mutation, but "nothing in the live UI subscribes to or renders
the region yet … the appStore … remains authoritative" (e.g. `connections_projection/projection.rs:44`).

This means:

1. **Dual authority.** For each shadow domain, the frontend `appStore` is authoritative *and* a
   full backend store mirrors it. They are kept consistent by hand via `fold_*_from_manager`
   calls sprinkled through the command layer (e.g. `commands/connection.rs:56` calls
   `fold_connections_from_manager` after every save/delete/move/import).
2. **Two writers into one region.** For domains like `connections`, the backend `fold_*` writes
   the store from the manager's authoritative snapshot, *and* the frontend render-cut mirror
   writes the same store via a `connection.replace` intent (documented as "additive … the
   render-cut `connection.replace` mirror stay[s] in place", `projection.rs:116`). Two
   independent writers to the same region with last-writer-wins semantics.
3. **Always-on cost for not-yet-live behaviour.** Every connection/agent/settings mutation now
   does extra work (rebuild the whole unified view, diff, fan out) to maintain a region nobody
   renders.

## Why it matters

Shipping a large architectural inversion half-done into a safety-critical release is the single
biggest structural risk in this crate. Dual authority is a classic source of subtle,
hard-to-reproduce divergence bugs: the two stores can drift whenever a fold path is missed on
some mutation, or when the frontend mirror and backend fold race. Right now the divergence is
*masked* because nothing renders the shadow region — which is worse, because the machinery is
running and being tested but its output is invisible, so a latent inconsistency only surfaces
at cutover, in the field, after the release. It is also a large, ongoing maintenance and
review burden (see TAURI-010).

Note: project memory states the inversion is "done (all 11 domains reducer/flag-free)", but the
`lib.rs` and `*_projection` source in this checkout still describes and wires these as shadows
with `appStore` authoritative. Whichever is true, the mismatch itself is a hazard (TAURI-007).

## Evidence

- `lib.rs:883-930` — nine `app.manage(Arc::new(<Domain>Store::new()))` + `register_*_intents`
  blocks each commented "Managed authoritative state that serves intents, but nothing in the
  live UI subscribes to or renders the region yet — a pure shadow foundation".
- `connections_projection/projection.rs:44-51` — "# Shadow mode … not driving the live UI … The
  `appStore` connections slice remains authoritative."
- `connections_projection/projection.rs:116-120` — the fold is "additive" and coexists with the
  frontend `connection.replace` mirror (two writers).
- `commands/connection.rs:50,56,87,103,128,142,154` — `fold_*_from_manager` hand-wired into
  every mutation command; `commands/agent.rs`, `commands/session.rs`, `commands/shell_integration.rs`
  do the same for their domains.

## Recommendation

Decide the state of the migration explicitly and finish or freeze it before release:

- If the inversion is meant to be live (per memory), **complete the cutover**: make the backend
  store the sole authority, delete the frontend `appStore` reducers and the `*.replace` mirror
  writers so there is exactly one writer per region, and drop the now-redundant `fold_*` +
  intent double-write. Update the module docs (TAURI-007).
- If it is genuinely still shadow, treat the shadow machinery as **not shippable in a
  safety-critical release**: gate it behind a build flag that is off in release, so the always-on
  dual-write cost and latent-divergence surface are not present in the shipped binary.

Either way, eliminate the "two writers into one region" arrangement — it has no correct
steady state.
</content>
