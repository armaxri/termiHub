---
id: PROD-041
title: Macros have no triggers (no hotkey, on-connect, or per-connection binding)
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: true
subsystem: src-tauri/src/macros
evidence:
  - src-tauri/src/macros/config.rs:22
  - src-tauri/src/workflows/config.rs:74
status: open
---

## What
A macro can only be run manually from the sidebar or command palette. There is no hotkey,
on-connect, or per-connection binding; triggers exist only on Workflows.

## Why it matters
Binding a macro to a key or firing it on connect is a core expectation. Today the only way is
to wrap the macro in a workflow `run-macro` step — a workaround, not a macro feature.

## Evidence
- `src-tauri/src/macros/config.rs:22` — no triggers field on `Macro`.
- `src-tauri/src/workflows/config.rs:74` — triggers exist only on `Workflow`.
- `src/types/macro.ts` — no trigger/hotkey/connection fields.

## Recommendation
Add optional hotkey and on-connect triggers to macros (reuse the workflow trigger model), or
document the workflow-wrapping pattern as the intended path.
