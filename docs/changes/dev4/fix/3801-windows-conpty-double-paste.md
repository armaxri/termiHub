### Fixed

- Right-click paste no longer inserts the text twice in terminal programs that use the
  mouse, such as Claude Code. When a program turns on mouse reporting, a plain
  right-click now goes to that program only, and termiHub no longer pastes or opens its
  menu as well. Hold Shift while right-clicking to use termiHub's own quick copy/paste or
  context menu in such a program; that click is not sent to the program. Right-click at a
  normal shell prompt is unchanged (#3801).
