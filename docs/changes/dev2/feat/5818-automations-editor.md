### Changed

- **One editor for every automation** (#5818) replaces the keystroke editor and the step editor.
  It opens on the name, the description and the steps, one line each; "When it runs", "Ask for
  values when it runs" and "Tags" open when you want them, and an automation that only types
  keystrokes shows nothing else. **Add step** lists the everyday steps first and the rest under
  More; keystrokes can now be combined with every other step, and have triggers.
- A step's … menu holds its options: typing speed, what happens when it fails, Move up and down,
  Duplicate and Delete. A step is moved by dragging its handle or with the arrow keys on it, and a
  deleted step can be brought back with Undo.
- Each trigger shows its settings right under itself, and an automation can have several triggers
  of one kind. The Armed switch and the schedules that run the automation are there too;
  "On a schedule…" opens the schedule editor. The Manual trigger, which had no effect, is gone.
- **Save and run** saves the automation and runs it as its row's Run does. It is what Enter in the
  name does for a new automation. Saving an unchanged automation no longer rewrites it.
- Waits, timeouts and retry waits are entered in seconds. The step "Send command" is now called
  "Run command", and "Run macro" is "Run automation" and offers every automation.

### Fixed

- The typing speed of recorded keystrokes is saved with each Type keys step (as recorded, the same
  delay before every key, or instant) and used however the automation is started; the command
  palette always typed at the recorded speed (#5820).
- Editing one of several triggers of the same kind no longer removes the others.
- The options of a choice asked for when an automation runs can be typed with their commas.
