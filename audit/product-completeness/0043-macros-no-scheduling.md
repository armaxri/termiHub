---
id: PROD-043
title: No macro (or workflow) scheduling
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: src/services/macroPlayback, src-tauri/src/workflows
evidence:
  - src/services/macroPlayback.ts:1
  - src-tauri/src/workflows/config.rs:74
status: open
---

## What
There is no cron/interval scheduling for macros or workflows; runs are manual, on-connect, or
hotkey only.

## Why it matters
Scheduled automation (run a health-check macro every N minutes) is a reasonable expectation
for an automation feature, though a lower priority for a desktop terminal.

## Evidence
- No cron/interval in `src/services/macroPlayback.ts` / macro slice.
- `src-tauri/src/workflows/config.rs:74` — triggers are Manual/OnConnect/Hotkey only.

## Recommendation
Consider a time-based trigger for workflows post-v0.1.0.
