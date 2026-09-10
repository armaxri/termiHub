---
id: A11Y-007
title: Primitives use a faint 22%-alpha focus ring, overriding the stronger global indicator
angle: accessibility
severity: medium
category: a11y
is_workaround: false
subsystem: src/styles, src/components/ui
evidence:
  - src/styles/variables.css:138
  - src/components/ui/ui.css:35
  - src/styles/global.css:91
status: open
---

## What

`global.css` defines a strong, high-visibility focus indicator for `:focus-visible` — a 2px
background-colored ring plus a 4px solid `--focus-border` ring (a double-ring that reads clearly on
any surface):

```css
:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--bg-primary), 0 0 0 4px var(--focus-border);
}
```

But every shared primitive overrides this on focus with `--shadow-focus`, which is a single, very
translucent ring:

```css
--shadow-focus: 0 0 0 3px rgba(61, 125, 232, 0.22);   /* variables.css:138 */
.ui-btn:focus-visible { outline: none; box-shadow: var(--shadow-focus); }   /* ui.css:35 */
```

At 22% alpha over the app's dark surfaces, the focus ring on buttons, inputs, selects, toggles,
checkboxes and the modal close button is faint and easy to lose — especially against the
accent-tinted selected-row backgrounds. Because the primitives set their own `box-shadow`, they
replace (not augment) the stronger global indicator.

## Why it matters

- **WCAG 2.4.7 Focus Visible (AA)** — technically met (an indicator exists), but a 22%-alpha ring is
  weak enough that low-vision keyboard users can lose their place.
- **WCAG 1.4.11 Non-text Contrast (AA)** — a focus indicator should have ≥3:1 contrast against
  adjacent colors; a 22%-alpha blue ring likely does not meet 3:1 over several of the app's
  backgrounds.
- Related: **2.4.13 Focus Appearance (AAA, WCAG 2.2)** on ring thickness/area.

## Evidence

- `src/styles/variables.css:138` — `--shadow-focus: 0 0 0 3px rgba(61, 125, 232, 0.22)`.
- `src/components/ui/ui.css:35` (button), also lines 167, 314, 406, 457, 614 (input, select, toggle,
  checkbox, modal close) — all `box-shadow: var(--shadow-focus)`.
- `src/styles/global.css:91` — the stronger indicator the primitives override.

## Recommendation

- Raise `--shadow-focus` to a solid, ≥3:1-contrast ring (e.g. a 2px inset/backing color + a 2px
  solid `--focus-border`, mirroring the global double-ring), verified against `--bg-primary`,
  `--bg-secondary`, `--bg-input`, and `--bg-selected`.
- Verify per-theme (dark, light, solarized ×2) since the ring is a single `:root` value.
- Add the focus-ring contrast to the `tokenDiscipline`/`contrast` test suite so it can't regress.
