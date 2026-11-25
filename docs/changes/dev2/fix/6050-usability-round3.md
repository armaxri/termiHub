### Changed

- **A trigger that can never start an automation is not offered without its reason**, and the row, the
  trigger's card and the editor's footer say why: it waits for you, it was imported in part, or a
  connection is gone. A row says "Triggers on" only when something can start it. (#6050)
- The Schedules header and the status bar count what failed and what was not run apart ("1 failed,
  1 not run"), open or closed; Pause all keeps its name.
- Stopping a run says where it was stopped and what was run before. A program you did not allow says
  so, and **Run again…** asks once more. The question before a run is stopped says how far it is.
- A run that waits sees that the password was typed and points to Continue. The row that waits is
  scrolled into view; the bar above the terminals announces a hidden one, no longer a second message.
- The run picker offers "Terminals in this split" only in a split, and says to open a terminal when
  there is none. Saving a recording that does not end with Enter says so.
- A new schedule starts as Daily.
- Deleting an automation names the schedules and automations that use it.
