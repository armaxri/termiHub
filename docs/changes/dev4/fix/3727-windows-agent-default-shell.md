### Fixed

- A termiHub agent running on Windows no longer creates its "Default Shell"
  connection pointing at `/bin/sh`. It now picks PowerShell 7 (`pwsh.exe`) when
  it is on `PATH`, then Windows PowerShell (`powershell.exe`), then `cmd.exe`
  via `%COMSPEC%`. An existing auto-created "Default Shell" that still points at
  a Unix path is repaired on the next agent start. Windows agents also now
  report their available shells instead of an empty list (#3727).
