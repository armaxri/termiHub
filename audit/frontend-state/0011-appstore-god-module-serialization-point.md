---
id: FES-011
title: appStore.ts is a ~8,150-line god module holding the domain slices, the layout engine, and dozens of per-tab maps in one file
angle: frontend-state
severity: medium
category: arch
is_workaround: false
subsystem: src/store/appStore
evidence:
  - src/store/appStore.ts:1
  - src/store/appStore.ts:1604
status: open
---

## What
`appStore.ts` is a single 8,156-line Zustand store definition. Even after nine domains were
inverted out to projection regions (agents, connections, settings, transfers, monitors, broadcast,
workflow-run, restore-cohort, session-lifecycle), the store still owns: the layout engine
(compose/reseed/mirror), ~15+ per-tab `Record<tabId,…>` maps (see FES-003), persistent sessions,
tunnels, macros, plugins, multi-window bookkeeping, restore orchestration, and every action over
them. The module-level mutable counters (`tabCounter`, `groupCounter`, `:1604,2711`) live here too.

The already-carved-out domains prove the seam works, but the residual file is still the single
place almost every frontend feature reaches into. Other audit angles measured the surface at
~361 state fields and ~224 actions.

## Why it matters
This is the frontend's serialization/coordination point and its largest single-file maintenance
liability. Practical costs seen in this audit:
- It is the file two agents most often collide on (the coordinator's own notes call the appStore
  import block a merge-conflict hot spot).
- Cross-cutting invariants (per-tab map pruning FES-003, id uniqueness FES-001/FES-004, delete
  cascades FES-009) are spread across thousands of lines, so they are enforced by convention and
  easy to break — several findings in this angle are instances of exactly that.
- It violates the repo's own "~500 lines per file" guideline by ~16x.

To be clear, this is not a *performance* problem: the selector layer is disciplined (small atomic
selectors, memoized `getComposedLayout`, shared empty constants), so the god module does not cause
whole-app re-renders. The cost is maintainability, review-safety, and invariant-integrity.

## Evidence
- `src/store/appStore.ts` — 8,156 lines; single `create<AppStore>` definition.
- `src/store/appStore.ts:1604,2711` — module-level mutable id counters co-located with everything
  else.

## Recommendation
Continue the slice extraction the projection inversion started: pull the remaining cohesive domains
(layout engine, per-tab runtime state as one normalized record per FES-003, persistent sessions,
tunnels, macros/plugins) into their own modules/slices with a thin composition in `appStore`. Route
all id generation through one shared helper (FES-001/FES-004). This lowers the merge-conflict
surface and makes the cross-slice invariants local and testable. Track as a standing refactor, not a
release blocker.
