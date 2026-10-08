---
id: WA-FE2-004
title: "Silent `.catch(() => {})` handlers have returned in new code and several were never migrated to fireAndForget"
angle: workaround-frontend
severity: low
category: workaround
is_workaround: true
subsystem: "components / hooks / store (error handling)"
evidence:
  - src/store/slices/monitoringSlice.ts:122
  - src/hooks/useFileDragOut.ts:107
  - src/components/NetworkTools/runHistory.ts:145
  - src/components/RemoteDesktop/RemoteDesktopTab.tsx:237
  - src/components/Terminal/TerminalView.tsx:332
  - src/components/LogViewer/LogViewer.tsx:50
  - src/components/Settings/PortableModeSettings.tsx:130
  - src/services/transport/WebSocketTransport.ts:76
  - src/components/NetworkTools/OpenPortsPanel.tsx:80
  - src/components/NetworkTools/PingPanel.tsx:186
  - src/hooks/useNetworkTask.ts:129
  - src/store/slices/windowManagementSlice.ts:195
  - src/utils/frontendLog.ts:176
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: WA-FE-005
---

## What

WA-FE-005 was closed as fixed ('critical + remainder via fireAndForget', #2732/#2751), and `fireAndForget(promise, reason)` exists in frontendLog.ts:176. Yet 13 production `.catch(() => {})` sites remain. Three were added after the fix (by git blame): monitoringSlice.ts:122 (2026-09-13, a failed monitor-region subscription is swallowed so the UI can sit in 'connecting'), useFileDragOut.ts:107 (2026-09-26, a failed `dragOutDiscardStaging` leaves a staging directory of downloaded remote files on disk with no trace), and runHistory.ts:145 (2026-09-26, a rerun failure). Others predate the fix and were never migrated: RemoteDesktopTab clipboard fetch, TerminalView logging-status sync, PortableModeSettings `listConfigFiles`, the LogViewer backend-buffer fetch, the projection unsubscribe, and the network-tool cancels. `refreshSessionOwners` (windowManagementSlice.ts:190-199) also swallows real IPC failures in an empty `catch {}`, justified only by unmocked unit-test stubs.

## Why it matters

These are the silent-failure pattern WA-FE-005 set out to remove, now growing back in new features. The drag-out staging leak and the monitor-subscription failure are real diagnosable faults that leave nothing in the LogViewer. There is no lint guard, so the count drifts back up after each sweep.

## Evidence

- `src/store/slices/monitoringSlice.ts:122`
- `src/hooks/useFileDragOut.ts:107`
- `src/components/NetworkTools/runHistory.ts:145`
- `src/components/RemoteDesktop/RemoteDesktopTab.tsx:237`
- `src/components/Terminal/TerminalView.tsx:332`
- `src/components/LogViewer/LogViewer.tsx:50`
- `src/components/Settings/PortableModeSettings.tsx:130`
- `src/services/transport/WebSocketTransport.ts:76`
- `src/components/NetworkTools/OpenPortsPanel.tsx:80`
- `src/components/NetworkTools/PingPanel.tsx:186`
- `src/hooks/useNetworkTask.ts:129`
- `src/store/slices/windowManagementSlice.ts:195`
- `src/utils/frontendLog.ts:176`

## Recommendation

Convert each site to `fireAndForget(p, "<reason>")`, using level `error` for the staging-discard leak path, or to an explicit `.catch(err => frontendLog(...))`. Log in `refreshSessionOwners`' catch and fix the test mocks instead of shaping production code around them. Add an ESLint `no-restricted-syntax` rule that bans `CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]` in src/ (excluding tests), so the pattern cannot return.

## Verification

Confirmed. rg finds 13+ non-test `.catch(() => {})` sites, including monitoringSlice.ts:122, useFileDragOut.ts:107 (discarding staging after a failure leaves no log if the discard fails), runHistory.ts:145, LogViewer, PortableModeSettings, TerminalView:332, and RemoteDesktopTab:237. refreshSessionOwners has an empty catch whose comment cites unit-test stubs. Mitigation: the original remediation (ERR-002) allowed truly best-effort teardown (unsubscribes, cancels) to keep empty catches if annotated, so part of the count is legitimate. The new staging-discard and monitor-subscribe swallows are real drift, and there is no lint guard.
