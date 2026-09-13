---
id: UI-009
title: ~366 raw px paddings/margins/gaps bypass the spacing scale
angle: ui-visual
severity: low
category: ui
is_workaround: false
subsystem: src/components
evidence:
  - src/styles/variables.css:102
  - src/components/Sidebar/ConnectionList.css:204
  - src/components/Settings/SettingsPanel.css:123
status: open
---

## What
The spacing scale is `--spacing-xxs: 2px` / `xs: 4` / `sm: 8` / `md: 12` / `lg: 16` /
`xl: 24` / `2xl: 32` (variables.css:102-109). A `grep` for raw
`padding:/margin:/gap: Npx` in `src/components` returns **366 matches**. Many are on-scale
values written raw (4/8/12/16px), but a meaningful share are **off-scale** — 6px, 10px,
14px, 20px — landing between tokens and producing subtly inconsistent density from one
panel/dialog/sidebar to the next.

## Why it matters
- Density rhythm is a big part of "feels finished." Off-scale gaps (6/10/20) mean rows,
  toolbars and dialogs that should share a rhythm are a pixel or two off from each other,
  which reads as slightly-misaligned throughout.
- On-scale-but-raw values (the majority) can't be retuned centrally, so a future density
  change to the scale won't propagate.
- This is the one systemic token-discipline area with **no guard at all** (colors, hex, and
  scrollbars are guarded; spacing is not), so it will keep growing.

## Evidence
`grep -rnE "padding:\s*[0-9]+px|margin:\s*[0-9]+px|gap:\s*[0-9]+px" src/components | wc -l`
→ 366.

## Recommendation
This is lower priority than the color/z-index findings (spacing drift is subtle, not
theme-breaking), but for a polished release: snap off-scale values (6→sm/md, 10→md, 20→lg/xl)
onto tokens, migrate the on-scale raw values to tokens opportunistically, and add a
spacing-token guard to `tokenDiscipline.test.ts` to stop new raw px from accumulating.
