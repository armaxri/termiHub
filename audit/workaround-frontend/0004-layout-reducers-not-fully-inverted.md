---
id: WA-FE-004
title: Layout domain still runs local reducers + optimistic overlay (reducer removal deferred, #2562)
angle: workaround-frontend
severity: medium
category: workaround
is_workaround: true
subsystem: store/appStore + store/layoutBridge
evidence:
  - src/store/appStore.ts:2745
  - src/store/appStore.ts:2772
  - src/store/appStore.ts:4023
  - src/test/layoutRegionTestHarness.ts:14
status: open
---

## What
The store/projection reducer-inversion is complete for 10 of 11 domains, but the **layout**
domain still keeps its local reducers as the transform-computing path, with an optimistic-fold
overlay, rather than being purely region-authoritative. `setLayoutLocal` /
`setAndReseed` (appStore.ts:2745-2789) run the reducer locally, write the non-layout fields to
`appStore`, and reseed/optimistically overlay the layout region; the layout fields round-trip
through the region as the "sole writer". Numerous structural writers still compute the tree in
the frontend (comments throughout appStore reference "#2283 slice E2 / #2562"). The test harness
states it plainly: *"the reducers stay authoritative for `appStore.rootPanel` under slice D'
(the fallback removal is still gated on #2283)"* (layoutRegionTestHarness.ts:14-15).

## Why it matters
- This is the last piece of the migration scaffolding described in the durable operating lessons
  ("reducer removal — deferred until after the extended-testing period"). It is intentional and
  tracked (#2562, hot-path layout reducer removal), but it is exactly the "instant-revert fallback
  that should now be gone post reducer-inversion" the audit targets.
- Keeping the local reducer + optimistic overlay means layout has two code paths (local compute +
  region mirror) that must stay in lockstep — a divergence class the other 10 domains no longer
  carry. It is extra surface to reason about on a core interaction (splits, tab moves, restore).

## Evidence
- `src/store/appStore.ts:2745-2789` — `setLayoutLocal` / `curLayout` / `setAndReseed` scaffolding
  explicitly tagged "#2283 slice E2 / #2562".
- `src/store/appStore.ts:4023` — "Optimistic-fold overlay (#2283 slice D')".
- `src/test/layoutRegionTestHarness.ts:10-15` — documents the retained fallback gated on #2283.

## Recommendation
Complete #2562: make the layout region the sole authority (route structural writers to
`layout.*` intents computed backend-side, drop the local reducers and the optimistic overlay),
matching the other domains. This is maintainer-gated on the extended-testing period, so it is a
release-checklist item rather than a free deletion — but it should not ship as a permanent
dual-path. Removing `setLayoutLocal`/`setAndReseed` and the slice-D' overlay is the signal it is
done.
