### Added

- macOS Finder integration for shell context-menu entries (#1369): installing
  the shell integration now writes an Automator Quick Action bundle per
  configured entry to `~/Library/Services/<name>.workflow`, so each "Open in
  termiHub" entry appears under Finder's **Quick Actions** and the **Services**
  menu. Selecting one runs `termiHub spawn --entry-id <id> --location "$@"` for
  the clicked folder or file. Registration is user-level (no admin rights) and
  idempotent; uninstalling removes only termiHub's bundles, leaving unrelated
  Quick Actions untouched. The app bundle also declares an app-level
  `NSServices` menu entry for file managers that surface app Services.
