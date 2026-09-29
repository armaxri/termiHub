---
id: DEAD-005
title: layoutBridge composeRenderTree() is unused; viewMatchesTree doc references dangle
angle: deadcode-flags
severity: medium
category: arch
is_workaround: false
subsystem: src/store/layoutBridge.ts
evidence:
  - src/store/layoutBridge.ts:614
  - src/store/layoutBridge.ts:14
status: fixed
resolution: "#2730"
---

## What
`composeRenderTree()` (exported, `layoutBridge.ts:614`) has **no callers** anywhere
in `src/` — only its own definition and doc-comment mentions. The live render path
uses `composeLayoutFromView()` (line 700) instead. Separately, four doc comments
`{@link viewMatchesTree}` a symbol that **no longer exists** (no definition, no
usage) — a dangling reference left behind when that gate function was removed.

## Why it matters
`composeRenderTree` is a fully-implemented, tested, exported function that nothing
uses — dead surface area that reads as live API. The dangling `viewMatchesTree`
`{@link}`s mislead a reader into believing a gate function exists that governs the
compose path.

## Evidence
- `grep -rn "composeRenderTree" src/ | grep -v layoutBridge.ts | grep -v .test.`
  → no results (zero callers outside its own file).
- `grep -rn "viewMatchesTree" src/` → only `{@link viewMatchesTree}` doc comments at
  `layoutBridge.ts:14,561,611,761`; no `function viewMatchesTree` / `viewMatchesTree =`
  definition anywhere.

## Recommendation
Delete `composeRenderTree` and its unit tests. Replace the `{@link viewMatchesTree}`
references with the function that actually gates the compose today (the
faithful-mirror / deep-equal check in `composeLayoutFromView`), or drop the phrase.
Verify the `.test.ts` for layoutBridge does not test `composeRenderTree` in a way that
must be preserved — if it only tests the dead function, remove those cases too.
