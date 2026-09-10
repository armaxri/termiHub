---
id: UI-010
title: !important overrides on the color picker and stale-stat coloring
angle: ui-visual
severity: low
category: workaround
is_workaround: true
subsystem: src/components/Terminal, src/components/StatusBar
evidence:
  - src/components/Terminal/ColorPickerDialog.css:36
  - src/components/StatusBar/StatusBar.css:236
status: open
---

## What
Two `!important` declarations are used to win specificity battles rather than through clean
cascade:

- `ColorPickerDialog.css:36-37` — `width: 100% !important; height: 150px !important;` on
  `.color-picker__picker`. This forces sizing onto a third-party color-picker component
  (react-colorful `HexColorPicker`) whose own inline/lib styles otherwise fix its size. The
  `150px` height is also a raw magic value with no token.
- `StatusBar.css:236` — `color: var(--text-secondary) !important;` on
  `.monitoring-status__stat--stale`, documented (lines 229-235) as needing `!important` to
  beat the more-specific per-severity color classes on the same element when stats freeze.

## Why it matters
- `!important` on a third-party component's geometry is brittle: a library update that
  changes its internal markup/wrapper can break the override silently, and it's the classic
  first shot in an `!important` war.
- The stale-stat override signals a **structural** issue: severity color and staleness are
  both applied to the same element via competing classes, so the "muted when stale" state can
  only win by force. That's a state-modeling smell — stale-vs-severity should be one resolved
  color, not two classes fighting.

## Evidence
`grep -rn "!important" src/components` (excluding the reduced-motion backstop, which is a
legitimate documented use). See the two lines above.

## Recommendation
- Color picker: size it via the library's documented API/props or a wrapping container that
  the lib respects, dropping `!important`; move `150px` to a token or an explicit sizing prop.
- Stale stat: compute a single resolved color in the component (stale overrides severity in
  JS/derived state) and apply one class, removing the `!important` and the class collision.
