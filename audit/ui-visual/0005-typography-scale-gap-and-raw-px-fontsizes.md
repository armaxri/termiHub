---
id: UI-005
title: Type scale has no tokens below 11px or above 14px; ~140 raw px font-sizes
angle: ui-visual
severity: medium
category: ui
is_workaround: false
subsystem: src/components, src/styles
evidence:
  - src/styles/variables.css:114
  - src/components/Sidebar/ConnectionList.css:535
  - src/components/Sidebar/ConnectionList.css:577
  - src/components/Settings/AboutSettings.css:6
  - src/components/Settings/LayoutPreview.css:76
status: open
---

## What
The font-size token scale is only four steps and spans a narrow range:
`--font-size-xs: 11px`, `--font-size-sm: 12px`, `--font-size-md: 13px`, `--font-size-lg: 14px`
(variables.css:114-117). Component CSS routinely goes outside it with raw px, and also
re-specifies the in-scale sizes as raw px instead of tokens.

Measured distribution of raw `font-size: Npx` in `src/components` (~140 declarations):

| px | count | in token scale? |
|----|-------|-----------------|
| 8  | 1  | no (below scale) |
| 9  | 4  | no (below scale) |
| 10 | 19 | no (below scale) |
| 11 | 49 | = xs, but written raw |
| 12 | 47 | = sm, but written raw |
| 13 | 21 | = md, but written raw |
| 14 | 2  | = lg, but written raw |
| 15 | 1  | no (above scale) |
| 16 | 4  | no (above scale) |
| 20 | 2  | no (above scale) |
| 22 | 1  | no (above scale) |

## Why it matters
- **No small-caption or display tier.** Badge/count/status text at 8–10px (19+ sites:
  ConnectionList badges, FileBrowser meta, Settings hints, LayoutPreview) and headings at
  15–22px (AboutSettings app title 22px, Plugins 15px, ConnectionList icon 20px) have *no
  token*, so those tiers drift per component — three different "tiny label" sizes (8/9/10)
  and four different "large" sizes (15/16/20/22) are in use with no rhythm.
- **~120 raw declarations duplicate existing tokens** (11/12/13/14), so a future scale change
  can't be made centrally and these won't move with it.
- Sub-11px text (8–10px) is also a legibility concern (defer contrast/size specifics to the
  a11y expert, but the visual inconsistency is real here).

## Evidence
`grep -rhoE "font-size:\s*[0-9]+px" src/components | sort | uniq -c` produced the table above.

## Recommendation
Extend the scale to cover what the app actually uses — add e.g. `--font-size-2xs: 10px`
(caption/badge), `--font-size-xl: 16px`, `--font-size-2xl: 20px`, `--font-size-3xl: 22px`
(headings/display) — collapsing 8/9 → 10 and 15 → 16 to remove the near-duplicate tiers.
Then migrate raw px font-sizes onto tokens and add a guard forbidding raw `font-size: Npx`
in `src/components/**`.
