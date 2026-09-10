---
id: FES-004
title: Tab ids are per-window monotonic counters (tab-N) that collide across desktop windows and are used as shared-region keys
angle: frontend-state
severity: medium
category: bug
is_workaround: false
subsystem: src/store/appStore
evidence:
  - src/store/appStore.ts:1604
  - src/store/appStore.ts:2331
  - src/store/appStore.ts:3244
  - src/store/appStore.ts:3238
status: open
---

## What
Tab ids are generated from a module-level counter: `let tabCounter = 0`
(`appStore.ts:1604`), incremented to form `` `tab-${tabCounter}` `` in `createTab`
(`:2331-2333`) and in the inline tab builders (`:3244-3246`, handoff `hydrateHandoffTab`
`:3238`). Each Tauri webview window is a **separate JS context** with its **own** module
state, so every window's `tabCounter` starts at 0. The first tab in window A and the first
tab in window B are both `tab-1`.

These ids are not window-local labels — they are used as **keys into shared/backend
regions**. The session-lifecycle region is keyed by the frontend tab id (see
state-machine-ux SM-003), and cross-window session handoff (`hydrateHandoffTab`,
`appStore.ts:3238`) moves a tab between windows. A `tab-1` in the destination window can
therefore collide with the source window's `tab-1`, and the multi-window session/ownership
bookkeeping (`session → window`, attachedTabIds) can address the wrong tab.

## Why it matters
- **Cross-window key collision** on a feature (multi-window, #1925) that exists precisely to
  run tabs in parallel windows. Two tabs sharing an id corrupt any map/region that treats the
  tab id as globally unique: React keys, selection, the tab→session→window ownership chain,
  and the shared session region.
- **Silent** — no error; the symptom is a wrong tab reacting to another window's session
  event, or a handoff landing on/replacing the wrong destination tab.
- Compounds SM-003 (session region keyed by tab id): the key is not just semantically wrong
  for multi-desktop, it is not even unique across this app's own windows.

## Evidence
- `src/store/appStore.ts:1604` — `let tabCounter = 0` (per-JS-context module state).
- `src/store/appStore.ts:2331-2333` — `createTab` → `` id: `tab-${tabCounter}` ``.
- `src/store/appStore.ts:3244-3246` — inline duplicate of the same scheme.
- `src/store/appStore.ts:3238` — `hydrateHandoffTab` builds a destination-window tab with the
  same `tab-${tabCounter}` scheme, i.e. an id minted by the destination window's counter.

## Recommendation
Make tab ids globally unique: `crypto.randomUUID()` (via the shared `newEntityId` helper
proposed in FES-001), or prefix the counter with a per-window id. Any id used as a
shared-region or cross-window key must be unique across windows by construction. Add a
regression test that spawns two windows, creates a tab in each, and asserts the ids differ;
and one that hands a session off and asserts it targets the intended destination tab.
