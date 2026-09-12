---
id: PROD-057
title: Terminal has no image/sixel/inline-graphics support
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: src/components/Terminal
evidence:
  - src/components/Terminal/Terminal.tsx:2
status: open
---

## What
No `@xterm/addon-image`/sixel handling; sixel- or iTerm2-image-producing tools render as
garbage escape sequences.

## Why it matters
Inline images (imgcat, sixel plots) are a nice-to-have increasingly expected in modern
terminals; without it those tools produce noise.

## Evidence
- No `sixel|ImageAddon|addon-image` anywhere in the repo.

## Recommendation
Consider adding the xterm image addon post-v0.1.0.
