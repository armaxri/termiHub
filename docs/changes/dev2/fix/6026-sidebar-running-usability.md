### Added

- An automation's row says what starts it by itself (hotkeys, triggers and the next scheduled run),
  in which terminal it runs and at which step (a click shows that terminal), that it waits for you,
  and why it cannot run. The selected row shows Edit. (#6026)
- A failed run names the step and what it does, with **Edit** and **History** beside it. An opened
  run in the History says what to do next, and can be run again or shown in its terminal.
- Closing the last window or quitting asks first while an automation runs, and names it.

### Changed

- **Enter and a double-click on an automation open its editor.** They used to run it. Run, the
  row's button, or **Ctrl+Enter** (macOS: **Cmd+Enter**) on the selected row runs it.
- **Armed / Off is now Triggers on / Triggers off**: the switch was never about running it by hand or
  on a schedule. An automation that has only a hotkey keeps its switch while it is on.
- An automation that cannot run (a step of a newer version, or a local program without experimental
  features) says **Cannot run** and why, in the sidebar, the run picker and the command palette,
  instead of offering Run.
- **Failed** also marks a run you started yourself, until one completes.
- Running on several terminals asks with each terminal's machine and tab group and what is typed.
  The choices read "Terminals in this split" and "All terminals in “group”"; **Run in parallel** shows
  when it matters.
- The command palette says **Run** before an automation and what Enter does ("types 3 steps in bash",
  "asks where", "Cannot run"), and that its triggers are off.
- The History says how a run ended in words on every row; a stopped run is **Stopped**.
- After an import, one dialog says per automation what was imported, left out, refused or switched off.
- **Pause all** is a button that becomes **Resume**. The status bar names what it counts.

### Fixed

- The spinner of a progress message lay on its text.
