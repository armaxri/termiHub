---
id: UI2-001
title: "Portaled Radix menus sit at --z-sticky (100), below the modal scrim and the update banner: the Open Connections 'Refresh interval' menu opens behind its modal"
angle: ui-visual
severity: medium
category: ui
is_workaround: false
subsystem: "src/components (z-index scale usage)"
evidence:
  - src/styles/variables.css:248
  - src/styles/variables.css:250
  - src/styles/variables.css:251
  - src/styles/variables.css:253
  - src/components/OpenConnections/OpenConnectionsModal.tsx:761
  - src/components/OpenConnections/OpenConnectionsModal.tsx:1121
  - src/components/OpenConnections/OpenConnectionsModal.tsx:1633
  - src/components/StatusBar/StatusBar.css:263
  - src/components/StatusBar/StatusBar.css:83
  - src/components/StatusBar/StatusBar.css:129
  - src/components/Sidebar/ConnectionList.css:252
  - src/components/ActivityBar/ActivityBar.css:120
  - src/components/UpdateNotification/UpdateNotification.css:10
status: fixed
resolution: "#4347 — every portaled Radix menu content now stacks at --z-popover; the Open Connections interval menu portals into its modal; tokenDiscipline guards it"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The UI-002 z-scale gives portaled Select/menu/popover content its own tier, --z-popover: 1100 ('above modals'). But every Radix DropdownMenu/ContextMenu content class uses var(--z-sticky) = 100: `.context-menu__content` (shared by 18 menus), `.monitoring-menu__content`, `.indent-menu__content`, `.lang-menu__content` and `.settings-menu__content`. Radix copies the content's z-index onto its popper wrapper, so these menus stack at 100 in document.body. MonitorRowActions is rendered inside the Open Connections <Modal> (OpenConnectionsModal.tsx:761/1121). It opens a DropdownMenu.Portal with no container (line 1633) styled with `.monitoring-menu__content`, so the menu lands under the modal scrim (900) and the modal surface (1000). The Workflow dialogs avoid this only because they pass useModalPortalContainer(). Second effect: the status-bar language, indent and monitoring menus open upward (side="top") in the bottom-right corner, which is exactly where the fixed UpdateNotification card sits (bottom:32px; right:20px) at --z-banner 500. While an update notice is showing, those menus render underneath it.

## Why it matters

In the Open Connections modal, the per-monitor refresh-interval control looks broken: clicking it opens nothing visible, because the menu is behind the dialog. The status-bar menus are partly covered whenever an update is pending. jsdom tests cannot see stacking, and the token guard only checks that a --z-\* token is used, not which one, so this passed CI. It also contradicts the scale's own documented contract.

## Evidence

- src/styles/variables.css:248
- src/styles/variables.css:250
- src/styles/variables.css:251
- src/styles/variables.css:253
- src/components/OpenConnections/OpenConnectionsModal.tsx:761
- src/components/OpenConnections/OpenConnectionsModal.tsx:1121
- src/components/OpenConnections/OpenConnectionsModal.tsx:1633
- src/components/StatusBar/StatusBar.css:263
- src/components/StatusBar/StatusBar.css:83
- src/components/StatusBar/StatusBar.css:129
- src/components/Sidebar/ConnectionList.css:252
- src/components/ActivityBar/ActivityBar.css:120
- src/components/UpdateNotification/UpdateNotification.css:10

## Recommendation

Move every portaled menu content class (`.context-menu__content`, `.monitoring-menu__content`, `.indent-menu__content`, `.lang-menu__content`, `.settings-menu__content`) to var(--z-popover). Narrow the --z-sticky comment to genuinely in-layout sticky chrome. Also pass container={useModalPortalContainer()} on the OpenConnectionsModal.tsx:1633 DropdownMenu.Portal, as #1868 does for the Workflow dialogs, so the menu stays clickable under the modal's pointer-events lock. To stop this coming back, extend tokenDiscipline.test.ts: any rule whose selector ends in \*\*content (Radix popper content) must use --z-popover or higher.

## Verification

I confirmed this from the code. In variables.css, --z-sticky is 100, --z-banner 500, --z-scrim 900, --z-modal 1000 and --z-popover 1100, and the --z-popover comment says portaled menus belong above modals. The `.monitoring-menu__content` rule (StatusBar.css:256-263) uses var(--z-sticky). So do `.indent-menu__content` (StatusBar.css:83), .context-menu\_\_content (ConnectionList.css:252) and the other evidence lines. Only the shared ui.css Select content (line 363) uses --z-popover. MonitorRowActions is rendered inside the Open Connections <Modal> (OpenConnectionsModal.tsx:1121). Its <DropdownMenu.Portal> at line 1633 passes no container, so the menu goes to document.body at z-index 100. The modal's overlay (ui.css:643, z 900) and surface (ui.css:660, z 1000) are also portaled to body, so they cover the menu. Modal.tsx already describes the same problem (#1868) and offers useModalPortalContainer() as the fix. The Workflow dialogs and Select use it, but this menu does not. I found no guard, ADR or audit decision that covers it. I'm lowering the severity to medium: one secondary control is broken (the per-monitor refresh-interval picker in one modal), with no data loss or safety impact. The status-bar menus are covered only while an update card is showing, which is cosmetic. The fix is a one-line container prop plus z-index token changes.
