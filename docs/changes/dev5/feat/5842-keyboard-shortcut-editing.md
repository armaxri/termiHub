### Changed

- Settings ▸ Keyboard shortcuts rows show a visible **Change** on each binding.
  Click it, press the new combination, and <kbd>Esc</kbd> or **Cancel** stops
  recording. An unchanged row reads "Default"; a changed one offers
  **Reset to default** (#5842).
- A combination that another action already uses is explained under the row,
  naming that action, with **Cancel** and **Reassign**. Reassigning moves the
  shortcut and shows a toast with Undo; clearing a shortcut with
  <kbd>Backspace</kbd> while recording now offers Undo too (#5842).
- The recorder refuses a plain function key for actions that fire in a focused
  terminal, since terminal programs keep those keys, and asks for Ctrl, Alt or
  Cmd instead (#5842).
- On keyboard layouts with Option/AltGr characters and dead keys (for example
  a German Mac), the recorder stores the key you pressed (Option+L is Alt+L),
  and refuses a dead accent key with a reason (#5842).
- The two help actions read "Show keyboard shortcuts (also from terminal)" and
  "Show keyboard shortcuts (not from terminal)", and rows that yield to a
  focused terminal say so (#5842).
