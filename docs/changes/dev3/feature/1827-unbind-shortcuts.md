### Added

- Keyboard shortcuts can now be **unbound** directly from Settings → Keyboard
  Shortcuts: each shortcut row has a clear (×) button that removes the binding so
  the action has no shortcut. An unbound action is shown as an italic `(unbound)`
  (not a blank cell), stays unbound across restarts (persisted as an empty
  override rather than reverting to its platform default), and no longer fires on
  its former keys. The per-row reset (↺) button restores the default, and
  Backspace while recording a shortcut also unbinds it. The shortcuts overlay and
  the exported HTML cheat sheet now label such actions `Unbound` too (#1827).
