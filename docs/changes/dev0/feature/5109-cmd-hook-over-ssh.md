### Added

- **Command Marks on a cmd.exe SSH host**: with the opt-in Command Marks
  (Shell Hook) setting on, an SSH session to a Windows host whose OpenSSH
  default shell is cmd.exe now follows `cd` in the file browser and gets prompt
  marks. termiHub adds the marks around your own `PROMPT`, erases the typed
  setup line from the screen and clears it from the console's command history
  (Alt+F7), so the up-arrow history and `doskey /history` stay clean and your
  doskey macros are kept.
