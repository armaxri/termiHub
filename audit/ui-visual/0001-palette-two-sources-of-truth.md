---
id: UI-001
title: Two disagreeing palettes — the "premium" variables.css color defaults never render
angle: ui-visual
severity: medium
category: ui
is_workaround: false
subsystem: src/styles, src/themes
evidence:
  - src/styles/variables.css:1
  - src/themes/dark.ts:9
  - src/themes/engine.ts:135
  - index.html:8
status: open
---

## What
The app has **two independent definitions of the dark palette that disagree**, and the
richer one never reaches the screen.

`src/styles/variables.css` `:root` defines a bespoke, bluish "premium" dark palette
(`--bg-primary: #0f1117`, `--bg-secondary: #161b24`, `--accent-color: #3d7de8`,
`--text-primary: #dde1ec`, …). But at runtime the theme engine (`applyTheme` →
`setCssVariables`, engine.ts:135) writes every *color* token as an inline style on
`document.documentElement` from the resolved `ThemeDefinition`. The default theme is
`darkTheme` (dark.ts), a flat **VS Code** palette (`bgPrimary: #1e1e1e`,
`bgSecondary: #252526`, `accentColor: #007acc`, `textPrimary: #cccccc`). Inline element
styles beat `:root`, so the VS Code palette wins for all ~50 mapped color tokens. The
`#1e1e1e` hardcoded in `index.html:8` (the pre-hydration background) confirms it — it
matches dark.ts, not variables.css.

Net effect: the `#0f1117` palette in variables.css — and the whole "premium" visual
identity the file's comments describe (noise overlay, spring-like easing, tinted grays) —
is **dead for every color token**. What ships is plain VS Code dark. variables.css remains
authoritative only for the *non-color* tokens (spacing, radius, shadows, fonts, z-index,
transitions), which the engine never sets.

## Why it matters
- **Design intent is not what ships.** The considered, on-brand palette (and the polish it
  was tuned against) is silently overridden by a flatter, more generic one. For a release
  where visual identity matters, the app looks less finished than its own design tokens
  intend.
- **The token file is a trap.** A designer who edits `--bg-primary` / `--accent-color` in
  variables.css to retune the look will see **no change** in the running app — the value is
  overwritten on mount. Half the file is live (structure), half is dead (color), with
  nothing signalling which.
- **Drift risk.** Two palettes that must be kept in sync but aren't checked against each
  other will diverge further with every edit.

## Evidence
- variables.css:1-99 — the `#0f1117` bluish palette + comments describing "premium" easing
  and a noise overlay (global.css:35).
- dark.ts:9-88 — the `#1e1e1e` VS Code palette actually applied.
- engine.ts:135-144 — `setCssVariables` sets each mapped token inline on the root element,
  overriding `:root`.
- index.html:8 — `<style>html, body { background-color: #1e1e1e; }</style>` matches dark.ts.

## Recommendation
Pick one source of truth. Either:
1. **Make dark.ts the canonical dark palette** and rewrite variables.css `:root` color
   defaults to match it exactly (so the fallback and the runtime agree, and the file stops
   lying), keeping only the non-color tokens as genuinely-authoritative; or
2. **Adopt the `#0f1117` premium palette as the shipped one** by porting those values into
   `dark.ts` (and `index.html`'s pre-load background), if that richer look is the intended
   identity.

Then add a small regression test asserting `variables.css` `:root` color defaults equal the
`darkTheme` values, so the two can never silently diverge again.
