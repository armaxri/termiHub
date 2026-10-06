### Fixed

- SSH connections with environment variables or X11 forwarding to a Windows
  host whose OpenSSH default shell is PowerShell or cmd.exe no longer corrupt
  the first typed command. termiHub now sets those variables (and `DISPLAY`) in
  the remote shell's own syntax — PowerShell `$env:` assignments, cmd.exe
  `set` — and types nothing for a shell it cannot detect. Variable names or
  values that cannot be typed safely (control characters, or `%`/`"` for
  cmd.exe) are skipped with a log line instead of being typed (#4147).
- SSH sessions to a Linux or macOS host whose login shell is PowerShell (`pwsh`)
  run the first typed command with Shell Integration on: the setup now waits
  for the first prompt, and the working-directory link names the host instead
  of sending a malformed `file:////` path (#4148).
