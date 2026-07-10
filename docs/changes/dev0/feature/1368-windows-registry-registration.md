### Added

- Shell integration (Windows): "Open in termiHub" Explorer context-menu entries
  can now be installed and removed. Registration writes user-level
  (`HKCU\Software\Classes\…`) registry keys — no administrator rights required —
  for right-clicking a folder, a folder's background, and a file, each invoking
  `termiHub spawn` at the clicked location. Entries marked "Extended" appear only
  under Shift+right-click, and three or more always-visible entries are grouped
  into a cascading **termiHub** submenu. Available via the new
  `install_shell_integration` / `uninstall_shell_integration` Tauri commands and
  the `termiHub install-shell-integration` / `uninstall-shell-integration` CLI
  subcommands. Registration is idempotent and reflected in the shell-integration
  status. macOS and Linux registration land in follow-up work (#1368, epic
  #1363).
