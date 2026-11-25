### Changed

- **Schedules say when, what, where and how it went** (#6024) — A schedule's row shows its next run,
  its rule, the automation and the connections, and whether the last run completed, failed, was
  skipped or was missed, with the whole reason. The coloured dot now always means an outcome; the
  switch says on and off. A schedule is On, Off or Paused.
- **A new schedule must say what to do with a closed connection** (#6024) — "Connect it" or "Skip it",
  with nothing preselected. Until now a new schedule skipped it unless "Connect if not connected" was
  ticked. Existing schedules keep their value.
- **The schedule editor says what will happen before you save** (#6024) — The next run and the
  connections, that it runs only while termiHub is open, whether it is off or saving switches it off,
  and when an automation asks for a value or may meet a password prompt nobody is there to answer.
- **One History for scheduled runs** (#6024) — The History also lists the scheduled times at which
  nothing ran, with the reason, and names the schedule of a run. The list of recent attempts on a
  schedule's row is gone; its "…" menu has "Show in History". "Clear…" in the History clears both.
  Schedules and the History use one date format.

### Fixed

- **Deleted connections are named** (#6024) — A schedule or trigger that still refers to a deleted
  connection says so, lets you remove it, and says that it will not run when none is left. Changing a
  schedule's connections to only deleted ones is refused.
- **The message that a saved schedule is off no longer disappears with the editor** (#6024) — The saved
  row is also brought into view and marked.
