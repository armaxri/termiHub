### Fixed

- Remote agents: a Windows agent installed under a user profile whose path contains a
  space (e.g. `C:\Users\John Smith\…`) can now be launched and version-probed over SSH
  when the host's OpenSSH `DefaultShell` is PowerShell, not only `cmd.exe`.
