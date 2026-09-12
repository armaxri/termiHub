---
id: UI-003
title: Hardcoded accent-blue in drop zones and network results ignores the active theme
angle: ui-visual
severity: medium
category: ui
is_workaround: false
subsystem: src/components/SplitView, src/components/NetworkTools
evidence:
  - src/components/SplitView/PanelDropZone.css:57
  - src/components/SplitView/PanelDropZone.css:107
  - src/components/NetworkTools/NetworkTools.css:104
  - src/components/NetworkTools/NetworkTools.css:113
  - src/components/NetworkTools/NetworkTools.css:407
status: fixed
resolution: "#2757"
---

## What
Several accent- and status-colored fills are hardcoded to fixed `rgba()` blues/reds/yellows
that do not reference any token, so they **do not track the active theme's accent/status
colors**:

- `PanelDropZone.css:57-58,107-108` — the split-drop preview highlight uses
  `rgba(38, 132, 255, …)` (a `#2684ff` blue). This matches *no* theme accent: dark is
  `#007acc`, light is `#0366d6`, and the (dead) variables.css default is `#3d7de8`.
- `NetworkTools.css:104` — `rgba(0, 122, 204, 0.15)` (VS Code blue `#007acc`) hardcoded for
  a selected/active row background.
- `NetworkTools.css:113` — `rgba(244, 135, 113, 0.12)` hardcoded error tint.
- `NetworkTools.css:407` — `rgba(204, 167, 0, 0.12)` hardcoded warning tint.

## Why it matters
- In **Solarized** and any **custom/plugin theme** (whose accent may be green, red, purple,
  etc.), the drag-to-split preview and the network-tool row highlights render a jarring
  VS-Code blue that clashes with the rest of the recolored UI. The drop preview is a
  prominent, full-panel affordance, so the mismatch is very visible.
- Even between the two built-in themes the drop-zone blue (`#2684ff`) matches neither, so
  it's slightly off in *every* theme.
- The status tints (error/warning) duplicate colors that already have theme-tracked tokens
  (`--color-error`, `--color-warning`, `--color-error-bg`, `--bg-warning`), so they will
  drift out of sync with the real status hues.

## Evidence
These slip through `tokenDiscipline.test.ts` because its rgba guard only matches the exact
`rgba(0,0,0,0.7)` scrim — arbitrary rgba colors are not caught.

## Recommendation
- Drop zone: use `color-mix(in srgb, var(--accent-color) 15%, transparent)` for the fill and
  `color-mix(… 50%, transparent)` (or a new `--accent-translucent` token) for the border, so
  the preview tracks the theme accent (matching how `--bg-selected` is already derived).
- NetworkTools rows: replace with `--bg-selected` / `--color-error-bg` / `--bg-warning` (or
  `color-mix` over the status tokens). Extend the token-discipline test to flag any
  `rgba(` with non-zero color channels in `src/components/**` (allow only pure-black/white
  overlays via tokens).
