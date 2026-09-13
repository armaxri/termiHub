---
id: ARCH-004
title: Layout domain is still dual-authority — appStore holds the panel tree while the region shadows it, with a live local-reducer fallback
angle: architecture-overall
severity: medium
category: arch
is_workaround: true
subsystem: src/store/layoutBridge.ts, src/store/appStore.ts, src-tauri/src/layout
evidence:
  - src/store/layoutBridge.ts:18
  - src/store/layoutBridge.ts:542
  - src/store/appStore.ts:2002
status: open
---

## What

Of the ~11 projection domains, **layout is the one that never completed the
migration** and remains dual-authority. The `appStore` still holds the
authoritative panel tree (`rootPanel` / `activePanelId`, composed on demand via
`getComposedLayout`, `getAllLeaves`) and the structural reducers (`splitPanel`,
`splitPanelWithTab`, move/merge) still run locally. The
`layout@<clientId>` region mirrors it:

- The **render cut** is on by default (region → derived tree).
- The **mutation cut** is gated by `layoutIntentsEnabled` and, when it fails,
  **falls back to the local mutation** (`layoutBridge.ts:542` —
  `"${kind} fell back to local mutation: ${message}"`; `:368` — "caller treats
  that as a bridge failure and falls back to the local mutation").
- The doc comment states the appStore panel-tree reducers "are removed in
  **step 4**" (`layoutBridge.ts:21`) — i.e. not yet. #2562 explicitly defers the
  hot-path layout reducer removal.

## Why it matters

- **Two authorities for the most-mutated UI state (the panel/tab layout).** The
  local tree and the region can diverge; the code keeps the local reducers alive
  precisely so it can revert to them, which means the region is not truly
  authoritative for layout. This is the exact "half-migrated / leftover reducers
  and fallbacks" hazard the audit flags.
- **`is_workaround`:** the retained local mutation + fallback path is a stopgap
  kept "just in case the backend round-trip fails" — dead-on-success code that
  must be removed once the cut is trusted, per the workaround mandate.
- On a safety-critical release, "which copy of the layout is real?" should have
  one answer, not "the region unless it errors, then the local tree."

## Evidence

- `src/store/layoutBridge.ts:18-21` — render cut shippable "without the async
  mutation flip … appStore panel-tree reducers are removed in step 4."
- `src/store/layoutBridge.ts:39-43,368,542` — mutation cut on by default but
  falls back to local mutation on any bridge failure; "keeps the local reducers
  for rollback."
- `src/store/appStore.ts:502,525,759-766,2002-2047` — `rootPanel`/`splitPanel`/
  `getComposedLayout` still local and authoritative; `#2562` deferral noted.

## Recommendation

Finish layout the way the other ten domains were finished: make
`LayoutStore` (`src-tauri/src/layout`) the sole authority, delete the appStore
panel-tree reducers and the `fell back to local mutation` path, and turn the
mutation cut on unconditionally (close #2562). Until then, this is the one domain
where the projection architecture's central invariant ("the backend is the
single authoritative writer") does not hold, and it should be called out as an
explicit pre-release blocker for the layout subsystem rather than left implicit.
