---
id: ARCH-001
title: appStore.ts is an 8k-line god-module holding most frontend state
angle: architecture-overall
severity: high
category: arch
is_workaround: false
subsystem: src/store/appStore.ts
evidence:
  - src/store/appStore.ts:1
  - src/store/appStore.ts:469
  - src/store/projectionCache.ts:9
status: open
---

## What

`src/store/appStore.ts` is a single Zustand store of **8156 lines** with **~361
state fields** and **~224 actions** in one `AppState` interface. It is the
central hub of the frontend: tabs, panel tree, tab groups, connections view,
agents, sessions, file browsers, monitoring, broadcast, transfers, credentials,
window hand-off, restore cohort, and more all live (or route) through this one
object. It is a known serialization point: every frontend feature cut touches
its import block or interface, so two agents editing it collide (this is exactly
why the coordinator pairs backend+frontend work to avoid `appStore.ts` import
collisions).

Twelve small slices have been extracted under #2077 (`slices/tunnelSlice.ts`,
`macrosSlice.ts`, `pluginsSlice.ts`, `dialogsSlice.ts`, etc.), but they are the
peripheral features. The core tab/panel/session/connection/agent/file-browser
state and its logic remain monolithic in the root file.

## Why it matters

- **Cohesion/coupling:** one module owns unrelated domains, so any change has a
  wide blast radius and unclear invariants. For a safety-critical release, the
  reviewer cannot reason about a single domain in isolation.
- **Serialization on the port:** it is the single busiest merge-conflict point
  in the frontend; parallel work is throttled by it.
- **Testability:** the 60+ `appStore.*.test.ts` files exist because behavior can
  only be exercised through the whole store. Slicing would allow focused tests.
- **It undercuts the projection story:** the stateless-UI substrate (ARCH-003)
  was supposed to turn each slice into a "dumb cache"; `projectionCache.ts:9`
  explicitly notes it "lives adjacent to the 8k-line appStore.ts rather than
  inside it" because there was no slice boundary to convert onto.

## Evidence

- `src/store/appStore.ts:469-480` — the `AppState` interface extends 12 slice
  types but still declares hundreds of its own fields/actions below.
- Field count: `grep -cn "^  [a-zA-Z_]*:"` → 361; action arrows → 224.
- `src/store/projectionCache.ts:9` — "Phase-1 note: this lives adjacent to the
  8k-line `appStore.ts` … there is no slice to convert yet."

## Recommendation

Continue the #2077 slice extraction to the *core* domains (tabs, panel/layout,
sessions, connections view, agents, file browsers) — not just the peripheral
features. The projection migration (ARCH-003) is the natural forcing function:
each domain that becomes region-backed should collapse its `appStore` slice into
a thin projected cache + intent dispatch, deleting the local state and reducers.
Target: `appStore.ts` becomes a composition root of slices, none over ~500 lines
(the repo's own file-size guidance). Track a concrete per-slice extraction
checklist rather than leaving #2077 open-ended.
