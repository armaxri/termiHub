---
id: I18N-017
title: No RTL readiness — layout uses physical CSS properties, no logical properties
angle: i18n
severity: low
category: i18n
is_workaround: false
subsystem: src/styles, src/components (CSS)
evidence:
  - src/styles
  - src/components/Settings/SettingsPanel.css:270
status: open
---

## What
The UI has no right-to-left (Arabic/Hebrew/Persian) support and is not structured
for it. Layout CSS uses **physical** directional properties
(`margin-left`/`-right`, `padding-left`/`-right`, `border-left`/`-right`,
`left`/`right` insets) — ~82 occurrences across `src/styles` and components — and
**zero** logical equivalents (`margin-inline-*`, `padding-inline-*`,
`inset-inline-*`). No element sets `dir="rtl"`/`dir="auto"` for locale direction;
the only two `direction: rtl` rules
(`SettingsPanel.css:270`, `FileEditor.css:70`) are the path-ellipsis trick
(show the end of a long path), not RTL locale support.

## Why it matters
Bucket B, low (until an RTL locale is a target). If termiHub is ever localized to
an RTL language, the entire chrome would need reworking: physical
left/right properties do not mirror, so sidebars, toolbars, icons, and padding
would render on the wrong side. Retrofitting logical properties across ~82 sites
plus establishing a `dir` strategy is a non-trivial effort best front-loaded into
the design system rather than bolted on later.

## Evidence
- `grep` over `src/styles` + `src/components`: ~82 physical `*-left`/`*-right`
  properties, 0 `*-inline` logical properties.
- No `dir="rtl"`/`dir="auto"` attributes in `src/**`.

## Recommendation
If RTL is a localization target: migrate the design system to CSS **logical
properties** (`margin-inline-start`, `padding-inline-end`, `inset-inline-*`,
`text-align: start/end`) and set `dir` from the active locale on a root element.
Do this in `variables.css`/shared component CSS so it propagates. If RTL is not a
near-term target, record that decision explicitly — but prefer logical properties
in *new* CSS from now on so the debt stops growing (cheap to adopt, no visual
change in LTR).
