---
id: PROD-042
title: Macro playback targets a single terminal; no send-to-multiple/broadcast
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src/store/slices/macrosSlice
evidence:
  - src/store/slices/macrosSlice.ts:301
status: open
---

## What
Macro playback injects into a single tab. Although a broadcast feature exists, macro playback
does not use it, so a macro cannot be replayed across all/selected terminals at once.

## Why it matters
Running the same macro across a fleet of hosts simultaneously is a top power-user use case for
a "terminal hub".

## Evidence
- `src/store/slices/macrosSlice.ts:301, 336` — single `targetTabId`, injects into one tab.
- Broadcast lives separately in `src/store/broadcastBridge.ts`.

## Recommendation
Allow macro playback to target a broadcast scope (all/panel/custom), reusing the broadcast
membership machinery.
