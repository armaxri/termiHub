### Fixed

- SSH to a Windows host: Windows PowerShell builds whose banner names the version
  ("Windows PowerShell 5.1") are recognised by it again, so connecting no longer
  runs the user's profile a second time.
- SSH and local shells: the setup line typed into the shell (environment variables,
  X11) no longer stays visible when it ends exactly at the right edge of the
  terminal under bash 3.2 (macOS).
