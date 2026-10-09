---
id: UX2-002
title: "Workspace launch from the command palette or a forwarded --workspace still tears down live sessions without the UX-026 confirm"
angle: ux-flows
severity: medium
category: destructive-action-guard
is_workaround: false
subsystem: "src/components/CommandPalette"
evidence:
  - src/components/CommandPalette/CommandPalette.tsx:284-285
  - src/components/WorkspaceSidebar/WorkspaceSidebar.tsx:73-99
  - src/store/slices/layoutPersistenceSlice.ts:351
  - src/App.tsx:246-248
  - src/utils/cliWorkspace.ts:24-38
status: fixed
resolution: "#4306 — palette and forwarded --workspace launches go through the guarded requestLaunchWorkspace"
audit: 2026-10
commit: 663465d52
relation: previous-incomplete
previous_id: UX-026
---

## What

The UX-026 fix (#2775) put the "N live sessions will be closed" confirm only into `WorkspaceSidebar.handleLaunch`. The command palette lists saved workspaces and, on Enter or click, calls `launchWorkspace(entry.workspaceId)` directly. `launchWorkspace` then runs `teardownAllSessions(get())` with no prompt. The `cli-workspace-requested` listener (a second `termihub --workspace X` forwarded to the running instance, #3101) calls `launchWorkspaceByName` → `launchWorkspace` the same way. Because the guard sits in one caller and not in the action, every new entry point bypasses it.

## Why it matters

The palette is the fastest, keyboard-first way to switch workspaces. One Enter on a fuzzy match can end every open session and replace the layout, which is the data loss UX-026 was meant to prevent. A shell alias that runs `termihub --workspace` against an already-open window does the same thing silently.

## Evidence

- `src/components/CommandPalette/CommandPalette.tsx:284-285`
- `src/components/WorkspaceSidebar/WorkspaceSidebar.tsx:73-99`
- `src/store/slices/layoutPersistenceSlice.ts:351`
- `src/App.tsx:246-248`
- `src/utils/cliWorkspace.ts:24-38`

## Recommendation

Move the live-session check into one shared entry point: a `requestLaunchWorkspace(id)` store action that sets a `pendingWorkspaceLaunch` (rendered by one app-level ConfirmDialog) when `getAllTabsAcrossGroupTrees().some(t => t.sessionId)`, and otherwise calls `launchWorkspace`. Call it from WorkspaceSidebar, CommandPalette and the forwarded-CLI listener. Keep the startup CLI path (App.tsx:166-168) direct, since nothing is live at boot. Add a CommandPalette test that a workspace entry with live tabs opens the confirm.

## Verification

I confirmed the finding in the code. The UX-026 live-session confirm exists only in WorkspaceSidebar.handleLaunch (WorkspaceSidebar.tsx:73-99). There, a check over getAllTabsAcrossGroupTrees() for tabs with a sessionId sets pendingLaunch.

Two other entry points call launchWorkspace with no check:

- **Command palette:** a workspace entry runs `void launchWorkspace(entry.workspaceId)` directly (CommandPalette.tsx:284-285).
- **Forwarded CLI:** the CLI_WORKSPACE_REQUESTED_EVENT listener in App.tsx (~246-248) calls launchWorkspaceByName(..., {reload:true}), which ends in `await launchWorkspace(ws.id)` (cliWorkspace.ts:24-38).

launchWorkspace has no live-session guard of its own. The only guard there blocks a second launch while one is in flight. It calls teardownAllSessions(get()) (layoutPersistenceSlice.ts:351), and restoreHelpers.ts:105+ closes every non-persistent session with apiCloseTerminal. The existing CommandPalette test (CommandPalette.test.tsx:189) launches on Enter and does not check for a confirm. I found no ADR or FINAL-SUMMARY note that exempts these paths on purpose.

I'm lowering it from high to medium for three reasons:

- **Deliberate action:** the user has to pick an entry labelled "launch workspace: X". A fuzzy match is still a deliberate selection, not a stray keystroke.
- **Persistent sessions survive:** they are detached and keep running, so only non-persistent sessions are lost.
- **CLI path:** this needs an explicit second `termihub --workspace` call from the user.

It is still a real gap in the destructive-action guard: the check lives in one caller instead of in the action, so these two entry points skip it.
