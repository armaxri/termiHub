---
id: UI-012
title: Elevation shadows are static and dark-tuned, weakening depth in the light theme
angle: ui-visual
severity: low
category: ui
is_workaround: false
subsystem: src/styles
evidence:
  - src/styles/variables.css:129
  - src/styles/variables.css:132
  - src/styles/variables.css:135
status: open
---

## What
All elevation shadows are single static `:root` values the theme engine never overrides
(only *colors* are theme-mapped). Two facets read wrong under the light theme:

- **Dark-only inset highlights.** `--shadow-dropdown` and `--shadow-overlay` include
  `inset 0 1px 0 rgba(255, 255, 255, 0.04/0.055)` — a faux top-edge catchlight that reads as
  subtle depth on a dark surface but is essentially invisible / slightly muddy on a white
  dropdown/modal in the light theme.
- **Opacity tuned for dark.** The drop-shadow alphas (`rgba(0,0,0,0.3–0.75)`) are calibrated
  against dark backgrounds. On the light theme's white surfaces the same shadow is heavier
  than the flat VS-Code-light look calls for, so dropdowns/modals feel more "shadowed" than
  the rest of the light UI.

## Why it matters
Depth/elevation is a core part of a coherent look. Because shadows don't participate in
theming, the light theme inherits the dark theme's elevation model, so floating surfaces
(Select content, modals, tooltips, recent-sessions popover) feel subtly off in light mode —
one of the places a theme most often looks "not quite finished."

## Evidence
variables.css:129-138 — `--shadow-sm/md/dropdown/overlay/focus`, all static; the engine's
`COLOR_TO_CSS_VAR` (engine.ts) maps no shadow token.

## Recommendation
Make elevation theme-aware: either add shadow tokens to the theme definition (per-theme
values) or, lighter-weight, override `--shadow-*` under a `:root` `color-scheme`/theme
selector for light themes with softer alphas and no white inset. This is low severity
(polish, not breakage) but visible on every floating surface in light mode.
