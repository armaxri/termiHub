---
id: PROD-049
title: Frontend JS plugin extensions (protocol parsers, status-bar widgets) are experimental and off by default
angle: product-completeness
severity: medium
category: workaround
is_workaround: true
subsystem: src/store/slices/pluginsSlice
evidence:
  - src/store/slices/pluginsSlice.ts:171
status: open
---

## What
Two of the four declared plugin extension points (JS protocol parsers and status-bar widgets)
run only when the experimental frontend-plugin gate is on; with it off, reconcile loads nothing
and unloads anything already loaded.

## Why it matters
Half the plugin extension surface ships disabled by default — finished capability hidden behind
an experimental flag. Users won't discover these extension points, and plugin authors can't rely
on them being available.

## Evidence
- `src/store/slices/pluginsSlice.ts:171` — experimental opt-in (#2048); off = load nothing.

## Recommendation
Decide whether these extension points are release-ready; if so, remove the experimental gate.
If not, document them as experimental in plugin-authoring docs. Tracked as a flag to resolve
before release.
