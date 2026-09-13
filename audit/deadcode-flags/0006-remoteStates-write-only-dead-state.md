---
id: DEAD-006
title: appStore.remoteStates is write-only dead state, fed on every session event
angle: deadcode-flags
severity: medium
category: perf
is_workaround: false
subsystem: src/store/appStore.ts, src/components/Terminal/TerminalView.tsx
evidence:
  - src/store/appStore.ts:1218
  - src/store/appStore.ts:6042
  - src/components/Terminal/TerminalView.tsx:78
status: open
---

## What
The `remoteStates: Record<string, string>` map in appStore is **write-only**. It is
initialized (`appStore.ts:6042`), and `setRemoteState` writes into it
(`appStore.ts:6043-6044`) on every remote-state change from `TerminalView`
(`TerminalView.tsx:78,133`) — but **no code ever reads the map**. `TerminalView`
itself notes the compact status is derived from the separate per-tab `tabStatus`
maps, and `tabStatus.ts:4` explicitly calls `remoteStates` the "legacy" map.

## Why it matters
Every active-session remote-state transition allocates a new object and triggers a
Zustand store update for a map nobody consumes — wasted renders/allocations on a hot
event path, plus dead state that confuses anyone reasoning about session status.

## Evidence
- Definition: `appStore.ts:1218` `remoteStates: Record<string, string>;`
- Only writer: `appStore.ts:6043` `setRemoteState: (sessionId, state) => set((s) => ({ remoteStates: { ...s.remoteStates, [sessionId]: state } }))`
- Callers of the writer: `TerminalView.tsx:78` and `:133` (both write).
- Readers: none. `grep -rn "remoteStates\[" src/` and `.remoteStates` reads → no
  consumer; `tabStatus.ts:4` labels it "the legacy `remoteStates`".

## Recommendation
Remove the `remoteStates` field, the `setRemoteState` action, and its two call sites
in `TerminalView`. The live status display already runs off `tabStatus`. Cross-check
with DEAD-007 (the dead `subscribeRemoteState` dispatcher path) — both are remote-state
residue and should be removed together.
