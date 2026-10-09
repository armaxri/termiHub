### Fixed

- Sorting: the remote-desktop "Upload to folder…" picker, Docker Compose
  project/service grouping and the plugin platform list now sort names
  naturally in your locale (`dir2` before `dir10`) (#4374).
- Dates: scheduled-run times ("today 09:00"), the embedded-server activity log
  and the backup "Created" date are now shown in your UI locale, and the
  "today"/"tomorrow" wording matches the date's language (#4374).
- File Transfer: Ctrl/Cmd+A selects all files on every keyboard layout, not
  only layouts where the A key types "a" (#4374).
- Shortcut hints: the Toggle Sidebar, New Tab Group, zoom-overlay and editor
  Save tooltips now show the real key for your platform and any custom
  binding — Toggle Sidebar no longer advertises Ctrl+B on Windows/Linux, where
  the default is Ctrl+Shift+B (#4374).
