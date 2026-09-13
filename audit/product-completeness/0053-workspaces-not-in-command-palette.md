---
id: PROD-053
title: Workspaces cannot be launched from the command palette
angle: product-completeness
severity: low
category: ux
is_workaround: false
subsystem: src/components/CommandPalette
evidence:
  - src/components/CommandPalette/CommandPalette.tsx:15
status: open
---

## What
The command palette lists commands, macros, workflows, and connections — but not workspaces,
so a saved workspace cannot be fuzzy-launched.

## Why it matters
Launching a workspace is a frequent action; its absence from the palette breaks the
keyboard-first flow that already covers connections/macros/workflows.

## Evidence
- `src/components/CommandPalette/CommandPalette.tsx:15-54` — entry kinds omit workspaces.

## Recommendation
Add a "workspace" entry kind to the palette that calls `launchWorkspace`.
