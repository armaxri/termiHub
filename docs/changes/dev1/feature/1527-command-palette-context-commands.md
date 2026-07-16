### Added

- Command palette (Cmd/Ctrl+P) now covers context-bound commands that act on the
  focused panel/terminal: **Close Tab**, **Next Tab**, **Previous Tab**, **Focus
  Panel Above/Below/Left/Right**, **Find in Terminal**, and **Clear Terminal**.
  Running one from the palette resolves the active panel/terminal at run time and
  behaves exactly like the matching keyboard shortcut (accelerators still come
  from the single keybinding source). Commands with no applicable target — e.g.
  Focus Panel Left with a single pane, or Find in Terminal on a non-terminal tab
  — appear disabled with a clear affordance and are inert on Enter/click (#1527).
