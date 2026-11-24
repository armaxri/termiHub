### Changed

- **Schedules run automations** (#5818): the schedule editor has one **Automation** picker
  instead of choosing between a workflow and a macro, and each attempt links the runs it
  produced in the single automation history. Existing schedules are migrated on first start
  and keep their targets, confirmation and history; a schedule whose macro or workflow was
  deleted keeps failing clearly instead of running something else. A copy of the old file is
  kept as `schedules.json.pre-automations.bak`, and an older termiHub shows the migrated file
  as unreadable instead of overwriting it.
- With experimental features off, a schedule no longer runs an automation that contains or calls
  a **Run local process** step (#5818). The editor lists such automations as disabled, and an
  existing schedule says why it will not run.
