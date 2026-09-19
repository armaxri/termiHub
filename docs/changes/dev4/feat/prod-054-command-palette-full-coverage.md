### Added

- Every keyboard-shortcut action is now runnable from the command palette
  (`Cmd/Ctrl+P`). The clipboard actions — Copy Selection, Paste, and Select All —
  were the last keybound actions missing from the palette; they now appear as
  entries that act on the focused terminal, driving the same handlers their
  Cmd/Ctrl shortcuts use (routed through the terminal command bridge). Each is
  disabled when no terminal tab is active and is a safe no-op otherwise (e.g.
  Copy with no selection), matching the shortcut's own guarding. Palette
  commands remain generated from the keybinding registry, so the coverage stays
  in sync with any newly added action (PROD-054).
