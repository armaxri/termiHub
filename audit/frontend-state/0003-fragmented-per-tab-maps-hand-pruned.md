---
id: FES-003
title: Per-tab state is scattered across ~15 parallel Record<tabId,...> maps pruned by hand-enumerated omitKey — drift and leaks
angle: frontend-state
severity: medium
category: arch
is_workaround: false
subsystem: src/store/appStore
evidence:
  - src/store/appStore.ts:4463
  - src/store/appStore.ts:5909
  - src/store/appStore.ts:1110
  - src/components/Terminal/Terminal.tsx:446
status: open
---

## What
A single tab's per-tab state is spread across ~15+ independent top-level maps, each
`Record<tabId, T>`: `tabContent`, `tabCwds`, `tabHorizontalScrolling`, `editorDirtyTabs`,
`tabColors`, `tabTerminalOptions`, `terminalSearchVisible`, `terminalSpawnErrors`,
`terminalRetryCounters`, `terminalConnectDeadline`, `terminalViewMode`,
`terminalReattaching`, `terminalReconnectPrompt`, `terminalAutoRetryCount`,
`terminalWaitingForAgent`, `terminalForceFreshReconnect`, plus the `tabStatus`-sourced
`terminalReconnectingTabs` / `terminalExitedTabs` / `terminalDisconnectErrors`.

There is no single "tab record". Instead, each lifecycle transition and the close seam
must **hand-enumerate** every relevant map. `closeTab` prunes ~15 of them one by one with
`omitKey(...)` (`appStore.ts:4463-4478`). Adding a new per-tab map requires remembering to
add an `omitKey` line to every seam that closes/moves/replaces a tab.

## Why it matters
- **Leak / drift by omission.** The pattern is fragile exactly where it is repeated: a map
  added but not wired into a close seam grows forever. `terminalForceFreshReconnect`
  (declared `appStore.ts:1110`, set `:5909`) is **not** pruned in `closeTab`; it relies on
  a lazy consume-and-clear in `Terminal.tsx:446-451` that only fires if a reconnect happens
  before the tab is closed. Close the tab first (the common case) and the entry is stranded
  — a small but unbounded leak and a stale one-shot flag if an id were ever reused.
- **Consistency hazard.** Because the maps are independent, a tab can exist in one map and
  be absent from another after a partial update, yielding inconsistent derived status. The
  correctness of `tabStatus` depends on *every* producer/pruner agreeing on the same key set
  by convention, not by construction.
- **Maintainability.** This is a large part of why `appStore.ts` is ~8k lines: the same tab
  is touched in a dozen disjoint places per operation.

## Evidence
- `src/store/appStore.ts:4463-4478` — `closeTab` prunes ~15 maps via individual `omitKey`
  calls (and the same enumeration is repeated at other tab-removal seams).
- `src/store/appStore.ts:1110` / `:5909` — `terminalForceFreshReconnect` declared and set
  but absent from the `closeTab` prune list.
- `src/components/Terminal/Terminal.tsx:446-451` — the only clear path for that flag is a
  consume-on-reconnect that does not run when the tab closes first.

## Recommendation
Normalize per-tab state into one `Record<tabId, TabRuntimeState>` (or fold it into the
existing `tabContent` record), so a close is a single key delete that cannot miss a field,
and derived status reads one record. Where a projection region already owns some of these
(session lifecycle), delete the store twin rather than adding another parallel map. Add a
dev-only invariant that asserts no per-tab map holds a key for a tab absent from the layout.
