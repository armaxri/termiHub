---
id: WA-FE2-007
title: "Restore auto-save guard uses a fixed 2s settle timer even though the restore cohort reports when every tab has settled"
angle: workaround-frontend
severity: low
category: workaround
is_workaround: true
subsystem: "store/restoreHelpers + layoutPersistenceSlice"
evidence:
  - src/store/restoreHelpers.ts:36
  - src/store/restoreHelpers.ts:45
  - src/store/restoreHelpers.ts:48
  - src/store/restoreHelpers.ts:50
  - src/store/slices/layoutPersistenceSlice.ts:498
  - src/store/slices/restoreCohortSlice.ts:28
  - src/store/slices/restoreCohortSlice.ts:47
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`beginRestoreGuard` raises `restoreInProgress` and lowers it after a hardcoded `RESTORE_SETTLE_MS = 2000`. Its own comment says the guard exists so per-tab connects that are 'still-connecting / agent-error' are not auto-saved over the good session. But SSH and agent connects routinely take longer than 2s (connect timeouts, jump hosts, agent bootstrap). Meanwhile the restore-cohort region (`beginRestoreCohort` / `settleRestoreTab`) already tracks exactly when every restored tab has connected or failed.

## Why it matters

A wall-clock guess sits next to an existing completion signal. With slow targets, auto-save resumes while the cohort is still mid-connect and persists the transient tree the guard was meant to keep out. With fast targets, auto-save stays blocked for no reason.

## Evidence

- `src/store/restoreHelpers.ts:36`
- `src/store/restoreHelpers.ts:45`
- `src/store/restoreHelpers.ts:48`
- `src/store/restoreHelpers.ts:50`
- `src/store/slices/layoutPersistenceSlice.ts:498`
- `src/store/slices/restoreCohortSlice.ts:28`
- `src/store/slices/restoreCohortSlice.ts:47`

## Recommendation

Lower `restoreInProgress` when the restore cohort settles (subscribe to the cohort region's settled/summary transition), keeping a generous max-timeout (e.g. 30s) only as a safety net. Add a test with a cohort tab that settles after 5s and assert that no last-session save fires before it does.

## Verification

Confirmed. restoreHelpers.ts:36-52 lowers restoreInProgress after a fixed RESTORE_SETTLE_MS=2000. Its own comment says the guard exists to keep still-connecting or agent-error per-tab states from being auto-saved, and layoutPersistenceSlice.ts:498 gates saving on it. Meanwhile restoreCohortSlice (beginRestoreCohort/settleRestoreTab) already tracks per-tab settlement and summarizes once the cohort empties, and nothing ties the guard to that signal. SSH or agent connects over 2s therefore escape the guard. Rated low because the concrete harm depends on how much transient state the save captures, which I could not show.
