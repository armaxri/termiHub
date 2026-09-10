---
id: WA-FE-008
title: Raw z-index magic numbers across CSS instead of design-system tokens
angle: workaround-frontend
severity: low
category: workaround
is_workaround: true
subsystem: styles / component CSS
evidence:
  - src/styles/global.css:40
  - src/components/UpdateNotification/UpdateNotification.css:10
  - src/components/ActivityBar/ActivityBar.css:120
  - src/components/SplitView/SplitView.css:54
status: open
---

## What
Stacking order is expressed with raw numeric `z-index` values scattered across ~20 CSS files
(`9999`, `9000`, repeated `100`, `10`, `11`, `5`, `4`, `3`, …), rather than referencing a shared
scale of tokens. The design-system rule (CLAUDE.md → UI/Design System §3) is "Tokens only — no
magic values … every … z-index references a token from `src/styles/variables.css`."

## Why it matters
- Uncoordinated numeric z-indexes are how "z-index wars" start: a new overlay picks `9999`, the
  next one needs `10000`, and layering becomes guesswork. Several already collide at the same
  value (`100` appears in ActivityBar, StatusBar, SplitView, FileBrowser, ConnectionList,
  KeyPathInput, WorkspaceEditor) so their relative order is source-order-dependent, not intended.
- `global.css:40` uses `9999` and `UpdateNotification.css:10` uses `9000` with no documented
  relationship — an update banner vs. a global overlay ordering is accidental.

## Evidence
`grep 'z-index:' src/**/*.css` returns raw numerics in App.css, global.css (9999), FileBrowser.css,
ConnectionList.css, KeyPathInput.css, SplitView.css (×2), PanelDropZone.css, UpdateNotification.css
(9000), StatusBar.css (×3), RemoteDesktopTab.css (×3), Terminal.css, TabBar.css, several Terminal
overlays, ActivityBar.css, WorkspaceEditor.css. None reference a `--z-*` token.

## Recommendation
Define a small ordered z-index token scale in `src/styles/variables.css` (e.g. `--z-base`,
`--z-dropdown`, `--z-sticky`, `--z-overlay`, `--z-modal`, `--z-toast`, `--z-tooltip`) and replace
the raw numbers with `var(--z-*)`. This makes layering intentional and reviewable. Zero raw
`z-index:` numerics outside `variables.css` is the signal.
