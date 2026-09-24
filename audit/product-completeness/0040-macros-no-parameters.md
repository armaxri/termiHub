---
id: PROD-040
title: Macros have no parameters/variables/prompts
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src-tauri/src/macros, src/services/macroPlayback
evidence:
  - src-tauri/src/macros/config.rs:11
status: fixed
resolution: "#3181 — parameterized workflows: WorkflowParameter model + resolveStepParams interpolating ${name} (with $${ escape) in send-command/run-script/run-local-process; editor Parameters section + run-time prompt dialog; no-param workflows byte-identical"
---

## What
Macro steps are opaque literal input (`data`, `delay_ms`). There is no parameter/variable
substitution and no prompt-before-run.

## Why it matters
Parameterized macros (prompt for hostname/env/path, then replay) are a common terminal-macro
feature; without them a macro is fixed text only.

## Evidence
- `src-tauri/src/macros/config.rs:11` — `MacroStep { data, delay_ms }`.
- No substitution in `src/services/macroPlayback.ts`.

## Recommendation
Support `{{variable}}` placeholders resolved via a pre-run prompt or workspace/connection
variables.
