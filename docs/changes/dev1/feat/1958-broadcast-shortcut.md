### Added

- Broadcast input can now be toggled with a keyboard shortcut
  (`Cmd+Shift+B` on macOS, `Alt+Shift+B` on Windows/Linux). It toggles broadcast
  against the focused terminal, reusing the last-used scope and skipping the
  scope dropdown; a remembered "custom" selection degrades to "all terminals"
  since it cannot be rebuilt without the picker. The action appears in Keyboard
  Settings and the command palette and is rebindable. On Windows/Linux the
  concept's suggested `Ctrl+Shift+B` was already taken by Toggle Sidebar, so
  broadcast uses `Alt+Shift+B` (matching the split/focus `Alt+Shift+…` pattern)
  (#1958).
