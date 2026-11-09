### Fixed

- SSH: with the opt-in Command Marks (Shell Hook) setting on, a session to a
  PowerShell host (Windows PowerShell 5.1 or PowerShell 7, on Windows or
  Linux/macOS) no longer clears the screen to hide the typed hook. The login
  banner and MOTD stay. The setup now erases only the rows its own typed line
  took (the prompt and the wrapped line), and the configured environment
  variables and X11 lines are typed with it, so none of them stay on screen
  either (#5044).
