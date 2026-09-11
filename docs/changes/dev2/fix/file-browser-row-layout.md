### Fixed

- Sidebar file browser rows: the filename is now the dominant element (it takes
  priority width and truncates with an ellipsis) while Modified, Size and
  permissions sit in an aligned right-hand meta group that no longer crowds or
  covers the name. The Size column now shows a real value for files (a missing or
  invalid size renders no size cell instead of `NaN GB`), and hovering a row
  shows the full filename and the absolute modified date/time as tooltips
  (#2798).
