### Changed

- Schedules can be edited in **Settings → Schedules** too, and "Pause all" shows only when there is
  a schedule to pause (#5818).

### Fixed

- The Add step menu of the automation editor is no longer cut off in a short dialog: its first
  steps could not be reached at any window size.
- The fields of the schedule editor no longer stick together.
- A macro or workflow file of an older version that cannot be read is reported at start instead of
  being replaced; what it holds is left as it is.

### Removed

- The commands and stores behind the old Macros and Workflows views. Files and backups of older
  versions can still be read.
