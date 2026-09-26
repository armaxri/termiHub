### Fixed

- Closing a tab in a window that shows **"Taken over by another window"** no longer
  closes the session the other window is using — for terminal and remote-desktop
  tabs. Closing a tab whose agent session another computer took over likewise
  leaves that session running there. The window or computer that controls the
  session still closes it as before.
