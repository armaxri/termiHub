### Fixed

- Deploying the remote agent to a Windows SSH host whose login shell is neither
  `cmd.exe` nor PowerShell (for example Git Bash) no longer fails half way: the
  agent `.exe` is now installed under `%LOCALAPPDATA%\termiHub\agent` with
  PowerShell (`powershell.exe -EncodedCommand`) from any login shell. When
  PowerShell cannot be run, or the install path is unusable, the deploy stops
  with a clear error before anything is uploaded (#5449).
- A Windows agent binary built for another CPU architecture (or one that is not
  a Windows executable) is now refused before it is uploaded (#5449).
