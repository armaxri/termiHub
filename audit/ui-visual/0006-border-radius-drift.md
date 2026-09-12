---
id: UI-006
title: Border-radius drift — raw 3/5/8/100px near-tokens and two ways to write "pill"
angle: ui-visual
severity: low
category: ui
is_workaround: false
subsystem: src/components
evidence:
  - src/components/Terminal/TerminalSearchBar.css:20
  - src/components/Terminal/Terminal.css:117
  - src/components/WorkspaceEditor/WorkspaceEditor.css:401
  - src/components/Terminal/TabGroupChips.css:18
  - src/components/Plugins/Plugins.css:255
status: open
---

## What
The radius token scale is `--radius-xs: 2px`, `--radius-sm: 4px`, `--radius-md: 6px`,
`--radius-lg: 10px`, `--radius-xl: 14px`, `--radius-full: 999px`. Component CSS uses raw
off-scale radii that don't land on any token:

- `3px` — TerminalSearchBar:20, UpdateNotification:67, StatusBar:390, WorkspaceEditor:254/493
  (between `xs` 2 and `sm` 4)
- `5px` — Terminal.css:117 (between `sm` 4 and `md` 6)
- `8px` — WorkspaceEditor:401 (between `md` 6 and `lg` 10)
- `100px` — TabGroupChips:18, WorkspaceEditor:95/154 (a pill; token is `--radius-full: 999px`)
- `999px` — Plugins.css:255 (correct pill value but written raw, not `--radius-full`)
- `6px` — UpdateNotification:8, TunnelEditor:80, TunnelDiagram:18 (= `md`, written raw)

## Why it matters
Corner radii are a strong part of the visual signature; three different "small" radii
(2/3/4), plus 5 and 8, mean controls that should look identical have subtly different
corners side by side. The "pill" shape is written three ways (`100px`, `999px`,
`--radius-full`), so pills can round differently at large sizes.

## Evidence
`grep -rn "border-radius:\s*[0-9]" src/components` — see list. `50%` (circles) is fine and
excluded.

## Recommendation
Snap each raw radius to the nearest token (3→xs or sm, 5→md, 8→lg, 6→`--radius-md`) and
replace every `100px`/`999px` pill with `--radius-full`. Add a guard forbidding raw
`border-radius: Npx` (allowing `50%`) in `src/components/**`.
