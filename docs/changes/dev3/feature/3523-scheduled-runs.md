### Added

- Scheduled workflows and macros: run a workflow or macro every N minutes, daily,
  or on chosen weekdays at a local time (DST-aware) on chosen saved connections or
  a broadcast group, while termiHub is open. Create one from the new
  **Schedules** list in the Workflows panel or the **Schedule…** action on a
  workflow or macro. Schedules start disabled; the first enable asks you to
  confirm the hosts it will type into; the status bar shows how many are active;
  **Pause all** stops them at once. A scheduled run only uses terminals that are
  already connected, never prompts, never overlaps its previous run, and is
  recorded in the run history as `scheduled`. Runs missed while termiHub was
  closed or the computer slept are skipped by default, or run once when termiHub
  is back. Schedules are included in backups (#3523, audit PROD-043).
