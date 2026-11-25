### Changed

- **Recording makes an automation** (#5818). "Record automation" in a terminal's … menu, the
  Automations sidebar, the command palette or a shortcut records what you type in that terminal.
  The Recording chip in the toolbar and a badge on the tab show it, and either stops it. Stopping
  offers a new automation, named after the first line you typed, or adding the recording to an
  automation you have.
- **Record steps** in the automation editor: type the next step in a terminal you choose, then
  "Stop and return" brings the editor back with your draft and the recording in it.
- "Run automation…" (was "Play macro…") in the … menu, the palette and the shortcuts offers every
  automation. Shortcuts you set for "Record macro" and "Play macro…" keep working.
- A recording is not lost by accident: closing the save dialog keeps it in a bar above the
  terminals, Discard recording can be undone, a closed or ended terminal asks what to do with what
  was typed, and closing the window or quitting asks first. It goes on after a reconnect.

### Fixed

- Pastes and dropped file paths are recorded; with the paste shortcut they were left out.
- Only the terminal you started in is recorded. Input to other terminals was mixed in, as were
  replies that a terminal sends by itself.

### Security

- What you type at a password prompt is no longer stored silently in a recording. The chip says
  "password prompt" while you type, and the password is left out unless you choose to store it
  unencrypted.
