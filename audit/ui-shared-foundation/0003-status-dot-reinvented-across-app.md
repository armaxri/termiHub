---
id: UISF-003
title: Status dot/indicator reinvented app-wide despite the shared SidebarStatusDot
angle: ui-shared-foundation
severity: low
category: ui
is_workaround: false
subsystem: src/components/SidebarListItem
evidence:
  - src/components/SidebarListItem/SidebarListItem.tsx:19
  - src/components/TransferQueue/TransferEntry.tsx:94
  - src/components/Sidebar/ConnectionPathDialog.tsx:187
  - src/components/Settings/UpdateSettings.tsx:108
  - src/components/StatusBar/UpdateIndicator.tsx:49
  - src/components/UpdateNotification/UpdateNotification.tsx:73
  - src/components/Settings/ShellIntegrationSettings.tsx:173
  - src/components/Plugins/PluginDetailPanel.tsx:101
status: open
---

## What

`SidebarListItem.tsx` exports a shared `SidebarStatusDot` primitive with a semantic tone API
(`neutral | success | warning | error`) mapped to design tokens (line 19). It is the intended
"every surface renders the same status affordance" component. But it is imported by only **two**
components (`EmbeddedServerSidebar/EmbeddedServerItem.tsx`, `TunnelSidebar/TunnelListItem.tsx`).

Everywhere else that shows a coloured status dot rolls its own `<span>` + a per-component BEM class
with ad-hoc colour modifiers:

- `TransferQueue/TransferEntry.tsx:94` — `transfer-row__status--${state}`
- `Sidebar/ConnectionPathDialog.tsx:187` — `connection-path-dialog__status--${status}`
- `Settings/UpdateSettings.tsx:108` & `StatusBar/UpdateIndicator.tsx:49` — `update-indicator__dot--${red|amber}`
- `UpdateNotification/UpdateNotification.tsx:73` — `update-notification__dot--amber`
- `Settings/ShellIntegrationSettings.tsx:173` — `shell-integration__dot--on`
- `Plugins/PluginDetailPanel.tsx:101` — `plugin-detail__status--${dot}`

## Why it matters

The colour semantics of a status dot (green=ok, amber=warning, red=error) are re-encoded in each
component's CSS with its own colour tokens/modifier names. `update-indicator__dot--red`/`--amber`
appears twice (StatusBar + Settings) with copy-pasted styling. Divergence risk: one place uses the
success token, another a raw amber; the tones will not stay consistent, and none of these honour the
one shared tone→token map.

## Evidence

Shared, under-used: `src/components/SidebarListItem/SidebarListItem.tsx:19-26` (`SidebarStatusDot`,
tokened tones). Reinvented sites listed in frontmatter — each declares its own `__dot`/`__status`
class + colour modifiers rather than reusing the tone API.

## Recommendation

Promote `SidebarStatusDot` to a general `StatusDot` in `src/components/ui/` (drop the "sidebar"
naming), keep the tone→token map as the single source of status colour, and migrate the reinvented
dots to it. Consolidates the duplicate `update-indicator__dot` styling and keeps status colours
consistent across sidebar, status bar, transfer queue, and settings.
