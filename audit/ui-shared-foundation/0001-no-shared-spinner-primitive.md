---
id: UISF-001
title: No shared Spinner/loading-indicator primitive — every feature reinvents Loader2 + BEM class
angle: ui-shared-foundation
severity: medium
category: ui
is_workaround: false
subsystem: src/components/ui
evidence:
  - src/components/Sidebar/FileBrowser.tsx:1316
  - src/components/Sidebar/FileBrowser.tsx:1612
  - src/components/FileEditor/FileEditor.tsx:1176
  - src/components/WorkspaceSidebar/WorkspaceListItem.tsx:57
  - src/components/StatusBar/StatusBar.tsx:718
  - src/components/StatusBar/StatusBar.tsx:934
  - src/components/RemoteDesktop/RemoteDesktopOverlay.tsx:36
  - src/components/RemoteDesktop/RemoteDesktopTab.tsx:155
  - src/components/Settings/UpdateSettings.tsx:141
  - src/components/Settings/ExternalFilesSettings.tsx:115
  - src/components/Sidebar/AgentSetupDialog.tsx:360
  - src/components/Sidebar/ConnectionPathDialog.tsx:188
status: fixed
resolution: "#2748"
---

## What

`src/components/ui/` exports `Button` (with a built-in async spinner) and `Progress`, but there is
**no standalone `Spinner`/loading-indicator primitive**. As a result, every feature that needs an
inline "working…" indicator hand-rolls the same thing: a lucide `<Loader2>` (or a bespoke `<div>`)
plus a per-component BEM class that re-declares the spin animation styling.

There are ~24 such inline spinner sites across the app, each with its own class name:
`file-browser__spinner`, `file-editor__spinner`, `workspace-item__spinner`,
`monitoring-status__spinner`, `rd-overlay__spin`, `settings-panel__spin`,
`agent-setup-dialog__spinner`, `agent-error-tab__spin`, `file-browser-tab__spin`,
`connection-path-dialog__status--spin`. They share the `motion-essential-spinner` helper class for
the keyframes but each component still redefines its own sizing/color/margin wrapper class.

## Why it matters

Ten+ per-component CSS blocks all express "a small spinning indicator." They drift independently
(sizes 12/14/20/30px chosen ad hoc, some spin via `Loader2`, some via a plain `<div>` in
`AgentSetupDialog`), so the loading affordance is visually inconsistent and every new feature copies
one of them rather than importing a primitive. This is exactly the "one implementation vs many" gap
the shared foundation is meant to close.

## Evidence

Representative sites (all `className="…__spinner motion-essential-spinner"` around a `<Loader2>`):

- `src/components/Sidebar/FileBrowser.tsx:1316,1612` — `file-browser__spinner`
- `src/components/FileEditor/FileEditor.tsx:1176` — `file-editor__spinner`
- `src/components/WorkspaceSidebar/WorkspaceListItem.tsx:57` — `workspace-item__spinner`
- `src/components/StatusBar/StatusBar.tsx:718,934` — `monitoring-status__spinner`
- `src/components/RemoteDesktop/RemoteDesktopOverlay.tsx:36` / `RemoteDesktopTab.tsx:155` — `rd-overlay__spin`
- `src/components/Settings/UpdateSettings.tsx:141` / `ExternalFilesSettings.tsx:115` — `settings-panel__spin`
- `src/components/Sidebar/AgentSetupDialog.tsx:360,369` — bespoke `<div className="agent-setup-dialog__spinner motion-essential-spinner" />` (not even Loader2)
- `src/components/Sidebar/ConnectionPathDialog.tsx:188` — `connection-path-dialog__status--spin`

## Recommendation

Add a `Spinner` primitive to `src/components/ui/` (thin token'd skin over `Loader2` with `size`
prop and the shared `motion-essential-spinner` keyframes owned in `ui.css`). Migrate the ~24 sites to
`<Spinner size="…" />`, deleting the per-component `__spinner`/`__spin` CSS. Prefer the async
`Button` state where the spinner is inside a button. This gives one loading affordance instead of a
dozen and one place to honour `prefers-reduced-motion`.
