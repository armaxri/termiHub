### Fixed

- SSH: on a Windows host whose login shell is cmd.exe, the lines that set the
  configured environment variables and the X11 `DISPLAY` no longer stay on screen or
  show up in the command history (up-arrow, `doskey /history`) when Command Marks are
  off. They were already hidden with Command Marks on (#5131).
