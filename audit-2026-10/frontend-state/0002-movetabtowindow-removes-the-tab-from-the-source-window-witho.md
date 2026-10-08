---
id: FES2-002
title: "moveTabToWindow removes the tab from the source window without the closeTab teardown (per-tab maps, session-lifecycle record, broadcast, persistent attachedTabIds)"
angle: frontend-state
severity: medium
category: state-integrity
is_workaround: false
subsystem: src/store/slices/tabGroupsSlice.ts
evidence:
  - src/store/slices/tabGroupsSlice.ts:411
  - src/store/slices/tabGroupsSlice.ts:454
  - src/store/slices/tabGroupsSlice.ts:477
  - src/store/slices/tabGroupsSlice.ts:494
  - src/store/slices/layoutSlice.ts:510
  - src/store/slices/layoutSlice.ts:528
  - src/store/slices/layoutSlice.ts:552
  - src/store/slices/layoutSlice.ts:629
  - src/components/Sidebar/PersistentStateDot.tsx:64
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

After a successful hand-off, moveTabToWindow strips the tab out of the source window's tree with setAndReseed. The returned patch contains only rootPanel, tabGroups, activePanelId and the transfer-session release. The destination then mints a brand-new tab id (hydrateHandoffTab → newId("tab")), so the old tab id is gone from every window. None of the teardown that closeTab performs for a removed tab runs here: (1) the old id's entries stay in tabContent, tabCwds, tabColors, tabTerminalOptions, editorDirtyTabs and the eleven `terminal*` per-tab maps; (2) no mirrorSessionIntent("session.remove", tabId), so the shared session-lifecycle region keeps a record for a tab that exists nowhere; (3) no broadcast cleanup, so if the moved tab was the broadcast source or a target, the shared broadcast region still names the dead tab id; (4) `persistentSessions[*].attachedTabIds` keeps the old id.

## Why it matters

Each move leaks state for the life of the source window and of the shared regions. Some of it is visible to the user. PersistentStateDot shows an attached-tab count that is too high by one per moved persistent tab. Broadcast can stay 'active' with a source tab that exists in no window, and a target list that includes a tab that can no longer receive input. The session-lifecycle region accumulates live-looking records keyed by dead tab ids, which every window's reconnect observer then iterates. This is the 'integrity by convention' risk named in FES-003 (each close seam hand-prunes ~15 maps): this seam prunes none of them.

## Evidence

- `src/store/slices/tabGroupsSlice.ts:411`
- `src/store/slices/tabGroupsSlice.ts:454`
- `src/store/slices/tabGroupsSlice.ts:477`
- `src/store/slices/tabGroupsSlice.ts:494`
- `src/store/slices/layoutSlice.ts:510`
- `src/store/slices/layoutSlice.ts:528`
- `src/store/slices/layoutSlice.ts:552`
- `src/store/slices/layoutSlice.ts:629`
- `src/components/Sidebar/PersistentStateDot.tsx:64`

## Recommendation

Extract closeTab's pure teardown into a shared helper: per-tab map pruning, persistent attachedTabIds removal, session.remove, and broadcast stop or target removal. Call it from both closeTab and moveTabToWindow. Keep closeTab's ownership-release and workflow-trigger steps out of the helper, because the session is moving, not closing. Add a test that moves a tab and asserts that no state keyed by the old tab id remains in the source window or in the session and broadcast regions.

## Verification

Confirmed. moveTabToWindow (tabGroupsSlice.ts:411-485) uses setAndReseed to return only rootPanel, tabGroups, activePanelId and the transfer release. The destination mints newId("tab"). None of closeTab's teardown runs (layoutSlice.ts:502-640): no mirrorSessionIntent("session.remove") (closeTab is the only caller), no per-tab map omitKey pruning, no persistentSessions attachedTabIds filter, no broadcast stop or target removal. PersistentStateDot reads attachedTabIds.length directly, so the attached-tab count is visibly too high. The leaks are shared-region records plus a user-visible miscount, which fits medium.
