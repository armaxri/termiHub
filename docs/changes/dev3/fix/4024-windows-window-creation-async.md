### Fixed

- Windows: opening a second window (File → New Window, moving a tab to a new
  window, or restoring a multi-window layout or workspace) no longer hangs the
  app. The window is now created off the WebView2 message callback, which
  deadlocked before (#4024).
