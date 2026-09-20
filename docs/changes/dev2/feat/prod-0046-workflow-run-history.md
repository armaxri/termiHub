### Added

- Workflow runs are now recorded to a persisted run history (PROD-0046). Each
  run — whether launched manually, by an on-connect trigger, or by a hotkey —
  is stored with its outcome (completed / cancelled / failed), start and end
  time, step progress, and what triggered it. The Workflows sidebar gains a
  "History" panel listing the most recent runs with a "Clear history" action.
  History is **metadata only** — terminal output is never stored — and is
  capped to the most-recent 200 runs. Recording is fire-and-forget: a
  history-write failure never fails or blocks the run itself.
