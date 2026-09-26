### Added

- Workflow steps can now handle failures (PROD-045). In the workflow editor, every step —
  including steps nested in a conditional or loop — has two new options:
  - **Retry on failure** — re-run a failing step up to 1–10 more times, with a delay between
    attempts (fixed, or exponential back-off that doubles each retry, capped at 60 s). The
    progress toast shows which attempt is running, and cancelling a run interrupts a retry
    wait immediately.
  - **Continue on error** — if the step still fails, the run records the failure and carries
    on with the next step instead of stopping. The finished-run toast and the run history
    show how many failures were tolerated.

  Workflows saved before this change keep their exact behaviour (no retry, the first failure
  stops the run), and their saved and exported files are unchanged.

- Workflows can run on several terminals at once (PROD-047). The new **Run on…** action on a
  workflow in the Workflows panel opens a picker of the connected terminals — the active one
  is preselected, or the broadcast group when broadcasting — with **Select all** and
  **Broadcast group** shortcuts. The workflow runs on each chosen terminal in turn; a
  terminal that is not connected is skipped, a failure on one terminal does not stop the
  others, **Stop** cancels the remaining terminals, and one summary toast reports the result
  per terminal. Every terminal gets its own run-history entry.
