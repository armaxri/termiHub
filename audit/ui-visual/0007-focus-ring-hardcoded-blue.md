---
id: UI-007
title: Focus ring glow is a hardcoded blue that doesn't track the theme accent
angle: ui-visual
severity: low
category: ui
is_workaround: false
subsystem: src/styles
evidence:
  - src/styles/variables.css:138
  - src/styles/global.css:122
  - src/components/ui/ui.css:35
status: open
---

## What
`--shadow-focus: 0 0 0 3px rgba(61, 125, 232, 0.22)` (variables.css:138) is a **static**
value. `rgba(61,125,232)` is `#3d7de8` — the *dead* variables.css accent (see UI-001), not
the runtime theme accent. It is used as the focus glow on inputs, selects, toggles,
checkboxes, buttons and modal-close across `global.css` and `ui.css` (7 files reference it).

Meanwhile the focus *border* uses `--focus-border`, which IS theme-mapped
(dark `#007fd4`, light `#0366d6`). So on focus, the 1px border tracks the theme but the 3px
glow around it is always the same `#3d7de8` blue.

## Why it matters
- In the **light** theme the glow blue (`#3d7de8`) sits next to a `#0366d6` focus border —
  two mismatched blues on the same focused control.
- In **Solarized / custom / plugin** themes with a non-blue accent, every focused control
  gets a blue halo that clashes with the theme's own accent and focus border. Focus is a
  pervasive state, so this shows on essentially every interaction.

## Evidence
variables.css:138 (static rgba); the theme engine's `COLOR_TO_CSS_VAR` (engine.ts) maps
`focusBorder` but there is no mapped token feeding `--shadow-focus`.

## Recommendation
Derive the glow from the theme accent instead of hardcoding it, e.g.
`--shadow-focus: 0 0 0 3px color-mix(in srgb, var(--focus-border) 30%, transparent)`. That
keeps it a single token but makes it track every theme (built-in, Solarized, custom, plugin)
automatically.
