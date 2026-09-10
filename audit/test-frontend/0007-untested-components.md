---
id: TFE-007
title: 23 component .tsx files have zero tests (SplitView, RemoteDesktop surface, LogViewer, …)
angle: test-frontend
severity: medium
category: test-gap
is_workaround: false
subsystem: src/components
evidence:
  - src/components/SplitView/SplitView.tsx
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx
  - src/components/Terminal/TerminalReconnectPrompt.tsx
status: open
---

## What

23 non-test `.tsx` components are never imported by any test, so they have **zero
test coverage** (and are also invisible to the coverage gate — see TFE-001). The full
list:

```
src/App.tsx
src/components/LogViewer/LogViewer.tsx
src/components/NetworkTools/LatencyChart.tsx
src/components/NetworkTools/NetworkDiagnosticPanel.tsx
src/components/NetworkTools/NetworkToolRunLocation.tsx
src/components/OpenConnections/MonitorRunLocation.tsx
src/components/RemoteDesktop/RemoteDesktopCanvas.tsx
src/components/RemoteDesktop/RemoteDesktopOverlay.tsx
src/components/RemoteDesktop/RemoteDesktopTab.tsx
src/components/RemoteDesktop/RemoteDesktopToolbar.tsx
src/components/RunLocationSelect/RunLocationSelect.tsx
src/components/Sidebar/Sidebar.tsx
src/components/SplitView/PanelDropZone.tsx
src/components/SplitView/SplitView.tsx
src/components/Terminal/AgentErrorTab.tsx
src/components/Terminal/TabGroupChips.tsx
src/components/Terminal/TerminalCommandBridge.tsx
src/components/Terminal/TerminalReconnectPrompt.tsx
src/components/Terminal/TerminalViewModeBanner.tsx
src/components/TunnelEditor/TunnelChainPreviewDialog.tsx
src/components/WorkspaceEditor/WorkspaceEditor.tsx
src/main.tsx
src/test/tooltip.tsx  (test helper — ignore)
```

Some have a same-named `*.test.tsx` (e.g. `RunLocationSelect`, `NetworkToolRunLocation`,
`MonitorRunLocation`, `TunnelChainPreviewDialog`) whose test file exists but imports a
different/higher module, so the component itself is still never instrumented — worth
confirming per file.

## Why it matters

The untested set includes **core structural and reliability surfaces**, not just
leaf widgets:

- `SplitView.tsx` + `PanelDropZone.tsx` — the split-pane layout and drag-and-drop
  drop-zone wiring. The underlying `panelTree.ts` logic is 90% covered, but the
  component that renders and mutates it is not.
- The **entire `RemoteDesktop/` render surface** (Canvas, Tab, Toolbar, Overlay) —
  only `RemoteDesktopCertPrompt` is tested. RDP is a shipped connection type.
- `TerminalReconnectPrompt.tsx`, `TerminalViewModeBanner.tsx`, `AgentErrorTab.tsx`,
  `TerminalCommandBridge.tsx` — reconnect/agent-error/command-bridge UI, directly on
  the reliability hot path.
- `LogViewer.tsx` — the surface the swallowed-error work (#2068) routes failures to;
  if it regresses, the whole "errors are now visible" guarantee is unverified.
- `App.tsx` — has a smoke test (`App.smoke.test.tsx`) but does not appear in the
  committed report; confirm the smoke test actually instruments it after TFE-001.

## Evidence

- Set difference of source `.tsx` files vs. paths present in `coverage/clover.xml`.
- `ls src/components/RemoteDesktop/*.test.tsx` → only `RemoteDesktopCertPrompt.test.tsx`.
- `ls src/components/SplitView/*.test.tsx` → only `EmptyWindowState`, `PanelErrorBoundary`.

## Recommendation

Prioritise by risk: add render + interaction tests for `SplitView`/`PanelDropZone`
(drop-target routing), the `RemoteDesktop` toolbar/overlay/tab (control actions and
disconnect states), and the Terminal reconnect/view-mode/agent-error banners (they
mount on failure paths and should be regression-locked). Leaf display components
(`LatencyChart`, chips, run-location selects) are lower priority but should at least
get a mount-without-throw smoke test so TFE-001's gate counts them.
