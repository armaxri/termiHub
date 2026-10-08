---
id: UISF2-008
title: "No shared Menu primitive: 16 files hand-assemble Radix menus, and the app-wide context-menu skin lives in Sidebar/ConnectionList.css"
angle: ui-shared-foundation
severity: low
category: arch
is_workaround: false
subsystem: "src/components/ui"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - src/components/Sidebar/ConnectionList.css:245
  - src/components/Sidebar/ConnectionList.tsx:73
  - src/components/LogViewer/LogViewer.tsx
  - src/components/Terminal/Tab.tsx
  - src/components/SplitView/SplitView.tsx
  - src/components/WorkflowSidebar/WorkflowStepRow.tsx
  - src/components/ActivityBar/ActivityBar.css:113
  - src/components/StatusBar/StatusBar.css:76
  - src/components/StatusBar/StatusBar.css:122
  - src/components/StatusBar/StatusBar.css:256
---

## What

ui/ has no DropdownMenu/ContextMenu wrapper. Sixteen components import `@radix-ui/react-dropdown-menu`/`context-menu` directly and repeat the Portal→Content→Item markup by hand: about 81 `className="context-menu__item"`, 8 `--danger`, and 19 separators. Five parallel menu skins exist (context-menu, settings-menu, monitoring-menu, lang-menu, indent-menu). The `.context-menu__*` styles used by LogViewer, Tab, SplitView, the Workflow components, FileBrowser and others are defined only in `Sidebar/ConnectionList.css`. They load only as a side effect of ConnectionList being statically imported.

## Why it matters

Menu item styling, danger treatment, separators, icon slots and collision/portal props cannot be changed in one place. Moving ConnectionList behind `lazy()` (as SplitView already does for other panels), or rendering a window without the sidebar, would silently unstyle every context menu in the app. Menus are the most common UI component without a shared primitive.

## Evidence

- `src/components/Sidebar/ConnectionList.css:245`
- `src/components/Sidebar/ConnectionList.tsx:73`
- `src/components/LogViewer/LogViewer.tsx`
- `src/components/Terminal/Tab.tsx`
- `src/components/SplitView/SplitView.tsx`
- `src/components/WorkflowSidebar/WorkflowStepRow.tsx`
- `src/components/ActivityBar/ActivityBar.css:113`
- `src/components/StatusBar/StatusBar.css:76`
- `src/components/StatusBar/StatusBar.css:122`
- `src/components/StatusBar/StatusBar.css:256`

## Recommendation

Add `ui/Menu.tsx` exporting `ContextMenu`/`DropdownMenu` content, `MenuItem` (with `danger`/`icon`/`shortcut` props) and `MenuSeparator` as token-styled skins over Radix. Move the `.context-menu__*` CSS into ui.css as `.ui-menu__*`. Migrate the 16 files mechanically, then fold the settings/monitoring/lang/indent variants into props.

## Verification

Confirmed. 16 non-test files import Radix dropdown-menu/context-menu directly, and ui/ has no Menu primitive. .context-menu\_\_item is defined only in Sidebar/ConnectionList.css, which is loaded through ConnectionList.tsx:73. That works today because Sidebar imports ConnectionList statically, so the risk is latent and the issue is mainly maintainability.
