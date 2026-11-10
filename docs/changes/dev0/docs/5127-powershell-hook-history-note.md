### Changed

- **Command Marks on a PowerShell SSH host**: the opt-in Command Marks (Shell
  Hook) setting's help now says that on a PowerShell host the hook leaves one
  line of setup in PowerShell's history per session, saved to the history file
  and shown again by the up arrow. PowerShell saves a typed line before it
  runs, so the hook cannot keep itself out (#5127).
