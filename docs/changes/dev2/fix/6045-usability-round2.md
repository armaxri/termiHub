### Added

- **Save and switch on…** saves a schedule and asks which hosts right away; the message after saving
  one that is off has **Switch on…**. (#6045)
- A missed or skipped scheduled run says what to do, with **Edit schedule** and **Run now…**; its
  schedule's row leads to the History, and one whose connections were deleted to the choice of others.
- The keys of a Type keys step that have no letter (arrows, Home, F1 to F12, Ctrl+C, …) are inserted
  with a click.
- A condition lists the values it can use. The dialog that asks for values says in which terminal the
  automation runs and where each value is used.
- An automation that was imported in part says so on its row until you have saved it once.
- Starting an automation that would stop the one in progress asks first; On connect never stops one.
  (#6042)

### Changed

- **A run that waits for you is continued only from its own terminal.** While that does not show, the
  bar offers to show it; the Continue shortcut and palette command show it too.
- How far a run is reads the same everywhere: the step it is at (row, tab, message), or the share of
  the keys typed. Stop says what it stops: **Stop all 2** on a row, "in 2 terminals" on the chip.
- A schedule that is off promises no next run ("When switched on: …"), one that will not run none on
  its automation's row either, and the status bar counts it. The schedule editor lists everything
  that is missing, and says what happens to a run that is missed.
- Only one of Schedules and History is open at a time, and takes the room. A failed or missed schedule
  shows in words in the section's header.
- What is typed at a password prompt while recording is announced under the toolbar instead of in the
  Stop button.
- Record in the Automations view opens a terminal when none is open. The selected row is highlighted.
- Run picker: each choice names its terminals. Quit: one sentence says what it ends and stops.

### Fixed

- **Stop ends a Wait step at once.** It used to take effect only after the wait, up to 5 seconds later.
- A press on Run or Stop of an automation could miss: its hidden buttons moved it while the pointer
  came in. Stop pressed before a run had begun its first step was lost.
- The spinner of a run no longer stays while the run waits for you or asks about a program.
