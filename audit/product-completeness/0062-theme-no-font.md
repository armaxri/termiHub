---
id: PROD-062
title: Font is not part of a theme definition (won't travel with exported themes)
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: src/themes
evidence:
  - src/themes/types.ts:1
status: open
---

## What
Theme definitions carry colors only; font family/size are global app settings. Switching
theme doesn't change typography, and exported themes don't carry a font.

## Why it matters
Users often expect a "theme" to bundle a font; a shared theme looks different on another
machine because the font isn't included.

## Evidence
- `src/themes/types.ts` — no font field; font lives only in appearance/terminal settings.

## Recommendation
Add optional font family/size to the theme schema (falling back to app defaults) and include
it in export/import.
