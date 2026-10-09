---
id: UI2-003
title: "--text-on-accent is a static white, but custom and plugin themes allow any accent, so a light accent makes primary buttons unreadable"
angle: ui-visual
severity: low
category: ui
is_workaround: false
subsystem: "src/styles/variables.css, src/themes"
evidence:
  - src/styles/variables.css:207
  - src/styles/variables.css:211
  - src/themes/colorTokens.ts:69
  - src/themes/engine.ts:141
  - src/components/ThemeEditor/ThemeEditor.tsx:183
status: fixed
resolution: "#4356 — textOnAccent theme token; custom/plugin themes derive it from the accent by WCAG contrast"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

variables.css:207-211 justifies a static #ffffff --text-on-accent with 'the accent is blue in every current theme'. That holds for the four built-ins, but the Theme Editor exposes accentColor as a freely editable token (colorTokens.ts 'Borders & Accent'), and plugin themes carry their own palettes. Neither textOnAccent nor any contrast check exists in src/themes or the ThemeEditor. A user who picks a light accent (a yellow or a pastel) gets white-on-yellow text on every primary Button, active workflow chip, shell-integration badge, checked checkbox, and so on (--text-on-accent appears in 12 component CSS files).

## Why it matters

Custom themes are a shipped feature. A light accent silently produces near-invisible labels on the most important actions (Save, Connect), and nothing in the editor warns the user.

## Evidence

- src/styles/variables.css:207
- src/styles/variables.css:211
- src/themes/colorTokens.ts:69
- src/themes/engine.ts:141
- src/components/ThemeEditor/ThemeEditor.tsx:183

## Recommendation

Add a textOnAccent key to ThemeColors and COLOR_TO_CSS_VAR, defaulting per built-in theme to #ffffff. In resolveCustomTheme and the plugin-theme validation, derive it automatically when it is not set: choose #000/#fff by WCAG contrast against accentColor (reusing the contrast helper behind contrast.test.ts). Alternatively, show a contrast warning next to the accent swatch in the ThemeEditor. Then update the variables.css comment.

## Verification

Confirmed. variables.css:207-211 is a static #ffffff with the 'accent is blue in every current theme' rationale. src/themes has no textOnAccent mapping and no contrast check. colorTokens.ts:69 exposes accentColor as editable, and plugin themes carry their own full palette. The problem only appears when a user or plugin author chooses a light accent, so low severity is right.
