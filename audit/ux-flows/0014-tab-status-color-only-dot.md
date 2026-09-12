---
id: UX-014
title: Tab connection status is a color-only dot, legible only on hover
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/Terminal
evidence:
  - src/components/Terminal/Tab.tsx:171
  - src/components/Terminal/Tab.tsx:33
  - src/components/Terminal/TabBar.css:140
status: open
---

## What
A tab's connection status is conveyed solely by a small colored dot
(`tab__state-dot--${status}`, `Tab.tsx:171-176`) whose color is set in `TabBar.css:140-156`. The
status word ("Connecting" / "Connection failed" / "Disconnected") exists only as a hover `title`
tooltip (`STATUS_LABELS`, `Tab.tsx:33-40`). There is no persistent text label and no non-color cue
(icon or shape).

## Why it matters
At a glance, connected vs. failed vs. disconnected is hard to distinguish — the user must
discriminate small color swatches and then hover to confirm. This is a status-legibility gap on a
core, always-visible surface (the tab bar), and an accessibility gap for color-vision-deficient
users (overlaps the a11y angle). Connection status is arguably the single most important piece of
state a terminal hub must communicate.

## Evidence
- `Tab.tsx:171-176` — color-only dot with `title` tooltip.
- `Tab.tsx:33-40` — status labels live only in the tooltip map.
- `TabBar.css:140-156` — status distinguished by color.

## Recommendation
Add a non-color cue to the status dot (distinct icon/shape per state, e.g. spinner for connecting,
warning glyph for failed) and/or a persistent short text/badge on the active or failed tab. Keep the
color, but do not rely on it alone.
