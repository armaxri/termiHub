### Added

- **Wait for you** step: an automation stops until you press Continue above the terminal, e.g. to
  type a password. **Continue the waiting automation** is in the command palette and can be given a
  shortcut. (#6025)
- A step can be added between two others ("+" between the rows, or **Add step below** in a step's
  menu).

### Changed

- **A password left out of a recording is now a real wait.** The automation used to go on after a
  pause as long as the password took to type, which could type the next command into the prompt.
  It now stops there until you press Continue, and ends after 5 minutes without it, or when the
  terminal closes. Such an automation does not start from a schedule, On disconnect or On output
  match: nobody is there to type. **Recordings saved before this still type on**; record them again
  or add a Wait for you step.
- The automation editor has **Save** as its primary button for new automations too, and Enter only
  ever saves. **Save and run** names the terminal it types into.
- An empty command, script, program, automation, pattern, comparison or hotkey keeps an automation
  from being saved. Stored ones with an empty field keep running as before.
- A hotkey is pressed instead of written, and the editor says which shortcut or automation already
  uses it.
- Enter, Tab and Esc show as ⏎ ⇥ ⎋ in the keys of a step; `\r`, `\t` and `\e` still work.
- Recordings say how long they took instead of counting keys; the recording chip reads
  **Stop recording**, and a run's chip names the automation.
- **Open settings** in a step that needs experimental features keeps the editor open behind it.
- Without a terminal, Record opens one.

### Fixed

- A recording into the editor can be canceled, and has one Stop.
- Submenus in a dialog are no longer cut off; a dialog shows that its content goes on below.
