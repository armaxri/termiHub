### Fixed

- SSH: on a Windows host whose login shell is cmd.exe, the configured environment
  variables and the X11 `DISPLAY` line are now typed only once the first prompt is up,
  and the first command (typeahead or a connection's initial command) only after they
  have run — so input typed while cmd.exe is still starting can no longer be dropped,
  matching the PowerShell fix from #4604. Linux/macOS hosts are unchanged (#4610).
