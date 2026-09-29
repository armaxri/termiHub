---
id: FES-007
title: layoutBridge carries dead compose functions and stale post-inversion docs (removed flags, broken @links, false "instant-revert" claim)
angle: frontend-state
severity: medium
category: workaround
is_workaround: true
subsystem: src/store/layoutBridge
evidence:
  - src/store/layoutBridge.ts:614
  - src/store/layoutBridge.ts:793
  - src/store/layoutBridge.ts:407
  - src/store/layoutBridge.ts:18
status: fixed
resolution: "#2730"
---

## What
`layoutBridge.ts` is the one bridge whose module docs no longer match the code after the
#2562 layout inversion, and it still contains executable dead code from the pre-inversion
design:

- **Dead executable functions:** `composeRenderTree` (`:614`) and `composeLayoutState`
  (`:793-869`) are defined but unused — every live reader (`appStore` `getComposedLayout`,
  `useLayoutRenderTree`, `layoutSelectors`) goes through `composeLayoutFromView` instead.
- **Broken doc links to removed symbols:** `{@link viewMatchesTree}` and
  `{@link seedLayoutRegion}` are referenced (header + `:426,561,565,611,761`) but neither
  function exists anymore.
- **References to removed feature flags:** `layoutIntentsEnabled` / `layoutRenderFromProjectionEnabled`
  (`:18-19,39,44`) are described as live gates ("on by default", "set to false to restore the
  pre-cut local reducers") but the flags were deleted in #2562.
- **False dual-authority claim:** `mirrorLayoutIntent`'s doc (`:407-410`) states "The `appStore`
  reducer has **already** applied the mutation to its authoritative `rootPanel`/`tabGroups` —
  the retained instant-revert path". Post-#2562, `setLayoutLocal` (`appStore.ts:2754-2764`)
  writes only `nonLayoutPartial(next)`; `rootPanel`/`tabGroups` are no longer stored fields
  (`appStore.ts:2487`, `:2838-2842`). The "instant-revert path the store keeps" does not exist.
- `logBridgeFallback`/`logRenderFallback` messages ("fell back to local mutation", "render fell
  back to appStore tree", `:542,965`) presuppose a local authoritative path #2562 removed.

The same class of residue exists in `sessionBridge.ts` (tracked separately as FES-008):
`effectiveReconnecting`/`effectiveReconnectTriggerError` docs describe a fallback to a local
slice that was deleted, and `logSessionBridgeFallback` still says "fell back to local lifecycle".

## Why it matters
This is exactly the "dead fallback code kept just in case / stale docs" the workaround mandate
targets. The concrete risks: (1) the unused compose functions are live maintenance surface that
can drift from `composeLayoutFromView` and be resurrected by mistake; (2) the docs actively
mislead the next engineer — they describe removed flags and a non-existent instant-revert path,
so a reader debugging a layout desync will look for authority in the wrong place. The layout
domain is the most complex remaining half of the inversion (#2562 deferred the hot-path reducer
removal), so accurate docs here have outsized value.

## Evidence
- `src/store/layoutBridge.ts:614`, `:793-869` — `composeRenderTree` / `composeLayoutState`
  defined, no live callers.
- `src/store/layoutBridge.ts:407-410` — false "already applied to authoritative rootPanel/tabGroups
  … instant-revert path" claim; contradicted by `appStore.ts:2487`, `:2838-2842`.
- `src/store/layoutBridge.ts:18-19,39,44` — references to removed flags.
- `src/store/layoutBridge.ts:426,561,565,611,761` — `{@link}` to removed `viewMatchesTree` /
  `seedLayoutRegion`.

## Recommendation
Delete `composeRenderTree` and `composeLayoutState` if truly unused (confirm with a reference
search). Rewrite the module header and `mirrorLayoutIntent` doc to describe the current
region-authoritative-via-mirror model (sole writer = the region→appStore subscription;
`layoutView` + `layoutSplitMarks` the only stored fields; the ~15 non-intent structural writers
reseed the region). Remove the removed-flag and broken-`@link` references and the "fell back to
local" log wording. Do this as a docs/dead-code cleanup PR separate from behavior.
