### Fixed

- Accessibility: connections, folders and remote agents in the sidebar can now be managed
  from the keyboard on every platform, including macOS. On a focused row,
  <kbd>Shift</kbd>+<kbd>F10</kbd> (or the Menu key) opens its context menu, <kbd>F2</kbd>
  opens the connection's or agent's editor to rename it, and <kbd>Delete</kbd> /
  <kbd>Backspace</kbd> starts the same confirmed delete as the menu. After a delete, focus
  moves to the next row instead of being lost (#5181).
- Accessibility: closing a confirmation dialog now returns focus to the control that
  opened it in every case, rather than sometimes dropping it to the page (#5181).
