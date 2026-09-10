---
id: SM-024
title: Layout freezes on a stale panel tree when composeLayoutFromView returns null (the #2562 stuck-state)
angle: state-machine-ux
severity: high
category: bug
is_workaround: false
subsystem: src/store/appStore.ts (layout) + src/store/layoutBridge.ts
evidence:
  - src/store/appStore.ts:8099
  - src/store/layoutBridge.ts:730
  - src/store/appStore.ts:2452
status: open
---

## What
The layout domain is a hybrid that matches neither authority model (issue #2562): the full
panel-tree reducers run **locally** in `setLayoutLocal` (`appStore.ts:2754`), the rich tree is
not stored but composed on demand (`getComposedLayout`, `:2452`), and `appStore.layoutView` is
written by exactly one place — the region-change subscriber (`appStore.ts:8099-8105`). That
subscriber applies the new view **only if** `composeLayoutFromView` returns non-null:
`if (composed) setState({ layoutView: view })` (`:8104`). When the authoritative region
advances to a view referencing a tab that is absent from `tabContent`, `composeLayoutFromView`
returns null (`layoutBridge.ts:730-733`, `reconcileNode` throw `:378-380`) and the subscriber
**silently skips the update**; `getComposedLayout` keeps reusing `lastComposedLayout`
(`:2459-2460`).

## Why it matters
Because tab create/close/reorder/activate are still local `appStore` edits that momentarily
desync the region from `tabContent` (per the comment at `layoutBridge.ts:562-565`), any desync
where content never catches up leaves the UI **frozen on a stale panel tree** while the
authoritative region has moved on. The only trace is a `frontendLog` — no user-visible error,
no recovery. This is the core stuck-state risk of the half-migrated layout domain: the panel
layout stops reflecting reality with no way for the user to tell or recover short of restart.

## Evidence
- `appStore.ts:8099-8105` — sole `layoutView` writer, gated on `composed != null`.
- `layoutBridge.ts:730-733`, `:378-380` — `composeLayoutFromView`/`reconcileNode` return
  null/throw on a missing tab.
- `appStore.ts:2452-2460` — `getComposedLayout` falls back to `lastComposedLayout`.

## Recommendation
Complete the #2562 migration so the layout region is authoritative with a thin-intent model
(no local full-tree reducer racing `tabContent`), or make the subscriber reconcile rather than
skip: when a view references an unknown tab, resolve it (fetch/placeholder) and apply, and
surface a recoverable error instead of silently freezing on the last-good tree.
