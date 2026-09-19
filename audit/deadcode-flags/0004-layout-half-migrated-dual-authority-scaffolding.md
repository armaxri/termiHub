---
id: DEAD-004
title: Layout is the one half-migrated domain — dual authority + gated fallback scaffolding
angle: deadcode-flags
severity: high
category: workaround
is_workaround: true
subsystem: src/store/layoutBridge.ts, src/store/appStore.ts, src-tauri/src/layout
evidence:
  - src/store/layoutBridge.ts:408
  - src/store/layoutBridge.ts:431
  - src/store/appStore.ts:2458
  - src-tauri/src/layout/mod.rs:11
status: open
---

## What
Of the 11 stateless-UI domains, layout is the only one still running its **local
appStore reducers as the authoritative source** alongside the backend region. The
projection/reducer inversion left layout with a deliberately-retained
"instant-revert" fallback and an optimistic-overlay mirror, tracked as the deferred
hot-path removal in **#2562**. Every other domain deleted its local reducers and made
the region sole-authority; layout did not.

## Why it matters
This is the largest block of migration scaffolding still load-bearing at release:
- `appStore` reducers mutate `rootPanel`/`tabGroups` locally (authoritative), then
  `mirrorLayoutIntent` dispatches the `layout.*` intent to the region under an
  optimistic overlay, "the retained instant-revert path that this slice deliberately
  keeps (the #2283 fallback removal stays gated)" (`layoutBridge.ts:408`).
- The backend `LayoutStore` still documents itself as **shadow / not authoritative**
  (`src-tauri/src/layout/mod.rs:11`: "This step is deliberately **not authoritative**").
Dual authority means two code paths that must stay in lock-step, a class the other
ten domains eliminated. It is the residual complexity a workaround-free release wants gone.

## Evidence
- `src/store/layoutBridge.ts:431` `mirrorLayoutIntent(...)` — local-first then mirror.
- `src/store/appStore.ts:2458` `composeLayoutFromView(...)` render path with an
  appStore fallback (render cut is live via `useLayoutRenderTree`, but mutation stays local).
- `src-tauri/src/layout/mod.rs` header still says "Shadow `LayoutStore` — Phase 3 step 1".
- Contrast: `src/store/sessionBridge.ts:24` "Backend-authoritative (migration flags
  removed, #2283)" and "local-fallback branches … deleted".

## Recommendation
Complete #2562: route layout mutations through `layout.*` intents as the sole
authority, delete the local `rootPanel`/`tabGroups` reducers and the
optimistic-overlay/instant-revert fallback in `layoutBridge.ts`, and promote the
backend `LayoutStore` from shadow to authoritative (updating its module docs). This
is genuine deferred work, not a trivial delete — the local reducers are currently the
source of truth, so the region must be proven faithful (cut-vs-local parity tests,
same pattern used for the other ten domains) before the reducers come out. Sequence
after DEAD-005 (delete the already-dead `composeRenderTree` first, it is unrelated
residue in the same file).
