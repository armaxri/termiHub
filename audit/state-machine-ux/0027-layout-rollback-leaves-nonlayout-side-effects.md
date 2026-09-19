---
id: SM-027
title: Layout optimistic rollback reverts structure but leaves coupled non-layout fields committed (divergence)
angle: state-machine-ux
severity: medium
category: bug
is_workaround: false
subsystem: src/store/appStore.ts (setLayoutLocal) + src/store/layoutBridge.ts
evidence:
  - src/store/appStore.ts:2761
  - src/store/layoutBridge.ts:540
  - src/store/ProjectionClient.ts:160
status: open
---

## What
`setLayoutLocal` commits the reducer's **non-layout** fields via `set(rest)`
(`appStore.ts:2761`) *before* the optimistic layout dispatch is acked. If the backend rejects
the `layout.*` intent, `ProjectionClient` rolls the overlay back to `baseView`
(`ProjectionClient.ts:160-163`) and the region subscriber reverts `layoutView` — but the
already-committed `tabContent` / `zoomedTabId` / session-map fields are **never undone** (only
a `logBridgeFallback`, `layoutBridge.ts:540`).

## Why it matters
On a rejected layout intent, the panel **structure** reverts while its **coupled content**
(which tab is zoomed, tab-content mapping) stays mutated → a structure/content divergence: the
tree says one thing, the content another. Low frequency (the backend nearly always accepts the
verbatim tree it was seeded with) but unhandled — an inconsistent state with no reconciliation.

## Evidence
- `appStore.ts:2761` — non-layout fields committed before ack.
- `ProjectionClient.ts:160-163` — overlay rollback to `baseView`.
- `layoutBridge.ts:540` — only logs on the fallback; no undo of the committed fields.

## Recommendation
Make the optimistic layout mutation transactional: stage the non-layout fields with the layout
overlay and roll both back together on reject, or recompose the coupled fields from the
authoritative view after a rollback so structure and content cannot diverge.
