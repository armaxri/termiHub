### Changed

- Windows Git Bash detection now finds installs beyond the two hardcoded
  `Program Files` locations. termiHub probes, in priority order: the Git for
  Windows registry `InstallPath` (HKCU and HKLM, including the 32-bit
  `WOW6432Node` view), the user-scope install under
  `%LOCALAPPDATA%\Programs\Git`, `git.exe` on `PATH` (deriving the sibling
  `bash.exe`, covering winget/choco/custom installs), the scoop per-user shim,
  and finally the original `Program Files` paths as fallbacks. Git Bash
  installed via winget, scoop, or in a user-scope/custom location now appears as
  the `gitbash` shell and launches from that same install.
