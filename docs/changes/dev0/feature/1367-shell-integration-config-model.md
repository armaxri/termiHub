### Added

- Shell-integration configuration model — the settings foundation for the "Open
  in termiHub" file-manager context menu and CLI spawn (epic #1363). A new
  `shellIntegration` block in the application settings holds the quick-access
  entries (each with a name, target connection or session-picker, Windows
  Always/Extended visibility, and folder/file/folder-background targets), the
  no-match fallback (session picker or system default shell), the
  open-in-new-window preference, the registration state and the executable path
  recorded at registration, per-file-manager toggles for Linux (Nautilus / KDE /
  Thunar), and the first-launch-banner dismissal flag. Older settings files
  without the block load unchanged. A new `get_shell_integration_status` command
  reports whether the integration is registered, whether the recorded executable
  still matches the current one (so a moved binary can prompt a re-register),
  whether the app is running in portable mode (where that staleness is expected),
  and which file managers were detected. Actual per-OS registration, file-manager
  detection, and the settings UI land in follow-up work under epic #1363 (#1367).
