### Fixed

- Quitting termiHub with Cmd+Q or the app menu's Quit on macOS no longer ends live sessions
  or discards unsaved editors without asking. It now shows the same dialog as closing a
  window, titled "Quit termiHub?", in every window that would lose something. A second
  Cmd+Q while the dialog is open is ignored, and Cancel keeps the app running. A logout,
  shutdown or the Dock's Quit still quits at once, so the OS never waits on the dialog.
