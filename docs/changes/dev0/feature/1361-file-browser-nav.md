# Changes — file browser navigation (#1361)

## Added

- **File browser breadcrumb path bar**: the current path is now a row of
  clickable breadcrumb segments (each navigates to that folder). A pencil button
  switches the bar into a free-text path input — type any path and press Enter to
  jump there, Esc (or click away) to cancel.
- **Keyboard-drivable file list**: the list uses a roving tabindex so it can be
  driven entirely from the keyboard — Up/Down to move, Home/End to jump to the
  first/last entry, Enter to open a folder or edit a file, Backspace or Alt+Left
  to go up a level, Ctrl/Cmd+A to select all, Shift+Arrow to extend the
  selection, and type-ahead to jump to a matching name.
- **Filter and sort**: a filter box narrows the list by name, and clickable
  Name / Modified / Size column headers sort the list (click again to reverse).
  File rows now show a Modified-time column.
- **Selection feedback**: an "N selected" indicator, clicking empty space or
  pressing Esc to clear the selection, and a persistent "Drop files here" hint in
  local mode.
