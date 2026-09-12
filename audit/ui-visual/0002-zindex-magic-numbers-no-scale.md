---
id: UI-002
title: Z-index magic numbers with no scale — stacking order is incoherent
angle: ui-visual
severity: medium
category: ui
is_workaround: true
subsystem: src/components, src/styles
evidence:
  - src/styles/variables.css:169
  - src/components/UpdateNotification/UpdateNotification.css:10
  - src/styles/global.css:40
  - src/components/StatusBar/StatusBar.css:83
  - src/components/SplitView/SplitView.css:54
status: fixed
resolution: "#2743 — coherent z-index scale; banners/overlays below modals"
---

## What
Only two z-index tokens exist — `--z-dropdown: 50` and `--z-toast: 1000`
(variables.css:169-171). Everything else is a raw magic number scattered across ~20
component files, and the numbers do not form a coherent stack:

- `9999` — global noise overlay (global.css:40)
- `9000` — UpdateNotification banner (UpdateNotification.css:10)
- `1000` — modals, toasts, tooltips, select dropdowns (via `--z-toast`, ui.css)
- `100` — FileBrowser, ConnectionList, KeyPathInput, SplitView (×2), StatusBar (×3),
  ActivityBar, WorkspaceEditor menus/popovers
- `10` / `11` — terminal search bar, disconnect overlay, view-mode banner, reconnect prompt,
  panel drop zone
- `1`–`5` — tab bar, terminal, remote-desktop layers

## Why it matters
- **Real stacking bug potential.** `UpdateNotification` at `9000` and the noise overlay at
  `9999` both sit **above** modals and toasts (`--z-toast: 1000`). An update banner would
  render *over* an open modal dialog and its scrim — almost certainly not intended, and the
  kind of thing that only shows up when two surfaces happen to coincide.
- The `100`-tier menus/popovers (StatusBar, ActivityBar, ConnectionList, FileBrowser) sit
  *below* the `1000` Radix Select content, so a native popover opened near a Select can be
  occluded inconsistently depending on which primitive drew last.
- No layering contract: every new overlay picks a number by eyeball, so the stack drifts
  and coincidental overlaps are found by accident, not design.

## Evidence
`grep -rn "z-index" src/components` returns 20+ raw literals; only
`RecentSessionsSidebar.css:38` uses a token (`--z-dropdown`). See file list above.

## Recommendation
Define a full z-index scale in variables.css and migrate every raw value onto it, e.g.
`--z-base`, `--z-sticky`, `--z-dropdown`, `--z-popover`/`--z-menu`, `--z-overlay`,
`--z-modal`, `--z-toast`, `--z-notification`, `--z-max` (noise overlay). Decide explicitly
where the update banner belongs relative to modals (almost certainly below the modal scrim)
and encode it. Add a lint/test forbidding raw `z-index:` literals in `src/components/**`
(mirroring the existing token-discipline guards).
