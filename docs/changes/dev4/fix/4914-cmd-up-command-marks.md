### Fixed

- Terminal: Cmd+Up / Cmd+Down (Ctrl+Shift+Up / Ctrl+Shift+Down on Windows and
  Linux) now jump to the previous / next command mark when typed into a focused
  terminal. The shortcut router mistook the terminal's hidden input field for a
  text box and dropped every terminal-scoped shortcut typed into the terminal,
  which also affected Find in Terminal and Clear Terminal (#4914).
