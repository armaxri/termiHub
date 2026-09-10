---
id: UX-026
title: Launching a workspace tears down all live sessions with no confirmation
angle: ux-flows
severity: high
category: ux
is_workaround: false
subsystem: src/components/WorkspaceSidebar
evidence:
  - src/store/appStore.ts:7641
  - src/components/WorkspaceSidebar/WorkspaceSidebar.tsx:36
  - src/components/WorkspaceSidebar/WorkspaceSidebar.tsx:147
status: open
---

## What
Launching a workspace calls `teardownAllSessions(get())` unconditionally
(`appStore.ts:7641`) before replacing the layout (`setAndReseed`, `:7647`). This destroys every
currently-open terminal/SSH/serial session and swaps the entire layout — instantly, with no user
confirmation. It triggers on a single gesture:
- Double-click / Play button on a workspace row (`WorkspaceSidebar.tsx:36-41` `handleLaunch` →
  `launchWorkspace` directly).
- **Enter** on a focused workspace row (`WorkspaceSidebar.tsx:147-152` `handleActivate`).

The only guard present is an in-flight re-entrancy guard (`appStore.ts:7478`), not a user
confirmation. Notably, **Delete** *is* guarded (`WorkspaceSidebar.tsx:59-66`, "This cannot be
undone"), yet Launch — which destroys live work — is not.

## Why it matters
A user with live, non-persistent sessions who clicks a workspace to "peek" or restore loses all of
that running work with no "This will close N live sessions — continue?" prompt. This is potential
loss of in-progress work on a common, easily-mis-hit action (single click / Enter), and it is
inconsistent with the guarded Delete. On the ventilator-grade bar, an unprompted destroy of live
sessions is a release-relevant data-safety gap.

## Evidence
- `appStore.ts:7638-7647` — `teardownAllSessions` runs before the layout swap, unconditionally.
- `WorkspaceSidebar.tsx:36-41,147-152` — launch fires on click and Enter with no confirm.
- `WorkspaceSidebar.tsx:59-66,251` — Delete *is* confirmed (the inconsistency).

## Recommendation
When launching a workspace would tear down live (especially non-persistent) sessions, show a
confirmation naming the count ("Launching '<name>' will close N open session(s). Continue?"). Skip
the prompt when there are no live sessions to lose. Reuse the existing ConfirmDialog pattern.
