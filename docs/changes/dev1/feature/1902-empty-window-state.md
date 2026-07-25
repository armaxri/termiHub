### Added

- Multi-window: the empty window is now a first-class state (epic #1899). A
  native window that holds zero tabs — right after **New Window**, or once its
  last tab is moved or closed — shows a deliberate call-to-action ("This window
  is empty" with **New Terminal** and **Open Connection…** actions) instead of a
  blank pane. The activity bar and sidebar stay mounted so a session can launch
  straight into the window.
- Multi-window: a top-level **New Window** command opens a fresh empty window,
  bound to **Ctrl/Cmd+Shift+N** and reachable from the command palette.
- Multi-window: the status bar shows the current window's name (e.g. "Window 2")
  when more than one window is open, so windows are distinguishable at a glance
  (#1902).
