---
id: PROD-052
title: No per-workspace settings (theme, env, default dir, shortcut profile)
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: src-tauri/src/workspace
evidence:
  - src-tauri/src/workspace/config.rs:97
status: open
---

## What
A `WorkspaceDefinition` carries only id/name/description/tab_groups/windows. There is no
workspace-scoped theme, environment, default working directory, or shortcut profile.

## Why it matters
Users switching between contexts (work/personal, prod/dev) often expect a workspace to also
carry visual/environmental settings, not just layout.

## Evidence
- `src-tauri/src/workspace/config.rs:97` — fields listed above only.

## Recommendation
Add optional per-workspace overrides (theme, env vars, default cwd) applied on launch.
