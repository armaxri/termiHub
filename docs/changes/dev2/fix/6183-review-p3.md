### Changed

- Automation editor: the save hint names the step to fix and what is wrong with it ("To save: fix
  step 2 (Run command): enter the command."), and the step is a link that opens it.
- The unsaved-changes prompt's buttons say what they do: **Keep editing** and **Discard changes**.
- A dialog opened over another (a schedule over its automation, a confirmation over an editor)
  hides the lower dialog's buttons, so only one set shows.
- An output trigger's empty limits read "10 (default)" and "5 (default)".
- An automation's row reads "Triggers on · Hotkey F8" or "Triggers off · Hotkey F8" on one line; that
  it can still be run is the switch's tooltip.
- The command palette's badges are sentence case: Automation, Workspace, SSH.
- History: one line per run, with a mark for a run a schedule, a trigger or another automation
  started; filtered to one automation, rows are titled by their terminal. A run another automation
  started names that automation and links to its run.
- The mark of what an automation typed sits on the line it typed, never on the output before it.
- "Monitoring unavailable" shows a warning icon; the host menu shows CPU, memory, disk and swap as
  usage bars.
