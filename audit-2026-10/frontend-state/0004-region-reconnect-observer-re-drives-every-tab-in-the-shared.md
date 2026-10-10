---
id: FES2-004
title: "Region reconnect observer re-drives every tab in the shared session region, including other windows' tabs, leaking per-tab entries"
angle: frontend-state
severity: low
category: state-integrity
is_workaround: false
subsystem: src/store/storeSubscriptions.ts
evidence:
  - src/store/storeSubscriptions.ts:56
  - src/store/storeSubscriptions.ts:60
  - src/store/slices/terminalSessionStateSlice.ts:536
  - src/store/slices/terminalSessionStateSlice.ts:554
  - src/store/reconnectHelpers.ts:69
status: fixed
resolution: "#4388 — the region reconnect observer skips tab ids not in this window's layout"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

wireSessionReconnectObserver is installed in every window. It iterates every entry of the shared session-lifecycle region and calls reconnectTerminal(tabId) on each waiting→connecting edge, without checking that the tab belongs to this window. For a foreign tab, isResilientReconnectTabId() returns false because the tab is not in this window's layout. reconnectTerminal therefore arms a 90 s connecting deadline and bumps terminalRetryCounters, terminalViewMode and related maps for a tab id this window will never close or prune.

## Why it matters

Every backend redrive attempt in window A writes stale entries into windows B..N. They are never removed, because closeTab only runs in the owning window. It is benign today, since only the owning window's TerminalConnectionOverlay reads the deadline. But it is another unbounded per-tab leak, and it would turn into a real misfire if any store-level code ever starts iterating terminalConnectDeadline.

## Evidence

- `src/store/storeSubscriptions.ts:56`
- `src/store/storeSubscriptions.ts:60`
- `src/store/slices/terminalSessionStateSlice.ts:536`
- `src/store/slices/terminalSessionStateSlice.ts:554`
- `src/store/reconnectHelpers.ts:69`

## Recommendation

In the observer, skip tab ids that are not in this window: `if (!collectLiveTabs(useAppStore.getState()).some(t => t.id === tabId)) continue;`, or the equivalent check against tabContent. Add a two-window test.

## Verification

Confirmed. The observer in storeSubscriptions.ts:56-63 iterates every entry of the shared session-lifecycle region (sessionBridge describes it as shared, with diffs reaching every subscriber). It calls reconnectTerminal(tabId) with no check that the tab is in this window's layout. For a foreign tab, isResilientReconnectTabId returns false (collectLiveTabs misses it), so reconnectTerminal arms a connecting deadline and writes per-tab maps that closeTab in this window never prunes. Today this is a benign leak, as the finding states.
