---
id: PERF-005
title: Every projection diff deep-clones the entire region view on the frontend
angle: performance
severity: medium
category: perf
is_workaround: false
subsystem: src/services/transport/ProjectionClient.ts
evidence:
  - src/services/transport/ProjectionClient.ts:204
status: open
---

## What
`ProjectionClient.applyDiff` applies each incoming RFC-6902 diff with
`applyPatch(this.baseView, diff.ops as Operation[], false, false)`. The 4th argument
(`mutateDocument`) is `false`, which makes `fast-json-patch` **deep-clone the whole
`baseView` document before applying the ops**. So the cost of adopting a diff is O(size of
the entire region view), not O(size of the diff) — every update to a one-byte field
structurally clones the complete region state.

## Why it matters
The projection substrate carries the app's live state: `sessions`, `connections`,
`system-monitors` (monitors + stats cache), `transfers`, layout, etc. These regions can be
large (many connections/sessions/monitors) and some update frequently (a monitor stats
sample every 2s per session; transfer progress every 100ms per active transfer — see
PERF-006/007). For each such diff the frontend deep-clones the entire region tree even
though the diff touched one entry. Under many monitors or several concurrent transfers this
is repeated full-tree cloning on the UI thread, plus GC pressure from discarding the old
tree each frame.

## Evidence
- `src/services/transport/ProjectionClient.ts:204` — `const result = applyPatch(this.baseView, diff.ops as Operation[], false, false);`
- `node_modules/fast-json-patch/index.d.ts:28` — `applyPatch(document, patch, validateOperation?, mutateDocument?, ...)`; `mutateDocument=false` triggers an internal `_deepClone(document)`.
- Consumers re-emit the whole view on each diff (e.g. `systemMonitorBridge.ts:116-126` rebuilds `{ monitors, statsCache }` and fans out to all listeners), so the clone feeds a full view rebuild + re-render each time.

## Recommendation
- Apply diffs with structural sharing so only changed paths allocate. Two options:
  1. Switch to an immutable-patch approach (e.g. apply ops via `immer` `produce`, or a
     patch applier that clones only along the touched paths) so the new view shares
     unchanged subtrees with the old one — O(diff) instead of O(view).
  2. If staying on `fast-json-patch`, mutate a single owned document (`mutateDocument=true`)
     and produce a new top-level reference for React via shallow copy of only the touched
     top-level keys.
- Structural sharing additionally lets downstream `useProjected*` selectors skip re-renders
  for untouched entries (referential equality), compounding the win.
</content>
</invoke>
