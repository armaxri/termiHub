---
id: PROD-044
title: Workflows are linear only — no conditionals, branching, loops, or wait-for-output
angle: product-completeness
severity: high
category: missing-feature
is_workaround: false
subsystem: src-tauri/src/workflows, src/services/workflowRunner
evidence:
  - src-tauri/src/workflows/config.rs:18
  - src/services/workflowRunner.ts:349
status: open
---

## What
The workflow step set is exactly 5 kinds (send-command, run-script, run-macro, wait,
run-local-process) and the runner walks them strictly in order. There is no conditional,
branch, loop, or wait-for-output construct.

## Why it matters
"Multi-step automation" strongly implies at least conditional logic or waiting for a command
to produce expected output before continuing. As-is, workflows are macros-with-step-types —
useful, but the flagship automation feature cannot make decisions.

## Evidence
- `src-tauri/src/workflows/config.rs:18` — 5-kind `WorkflowStep` union.
- `src/services/workflowRunner.ts:349` — strict in-order execution.

## Recommendation
Add a wait-for-output/expect step and a basic conditional (if last-step-output matches → run
branch), plus a loop/repeat step. This is the highest-leverage automation gap.
