### Fixed

- Terminal: on macOS, a right-click in the terminal could paste instead of
  opening the terminal context menu. macOS fires the context-menu event on the
  button's press, so its release landed on the freshly opened menu and selected
  its first item (Paste). Context menus now ignore the release of the press that
  opened them, so the menu (Copy Selection / Paste / Copy All …) stays open.
  Quick Copy/Paste remains an opt-in setting (Settings > Terminal > Right-Click
  Behavior) and the Windows platform default (#4915).
- Terminal: the zoomed terminal (panel zoom overlay) now has the same right-click
  menu as a terminal in a panel; previously only the overlay title's tab menu
  offered a copy (#4915).

### Changed

- Terminal: the tab and zoom-title menus now call the full-buffer copy
  **Copy All**, matching the terminal context menu (was "Copy to Clipboard")
  (#4915).
