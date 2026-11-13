### Changed

- File browser: to type a path, click the current folder in the path bar or the
  empty space after it, or press Cmd+L (Ctrl+L on Windows and Linux) while the
  file browser has focus. The editor opens with the full path selected; Enter
  goes there and Escape cancels. The separate edit button is gone. The other
  folders in the path still navigate on click (#5540).

### Fixed

- Transfer view: a long path in either pane no longer hides the folder you are
  in. Each pane shows the same path bar as the sidebar file browser: the
  current folder stays visible, the middle folders fold into "…", and the full
  path is the tooltip and the value of the edit field (#5541).
