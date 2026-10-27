### Fixed

- A new terminal tab no longer garbles a long command line. A tab that connected
  before its panel was laid out briefly sized its shell to 2 columns; on macOS
  bash redrew its line for that width, so the next prompt overwrote the end of
  the line and shell integration (command marks) did not set up. Terminals are
  no longer sized until their panel has a real size (#5025).
- Typing right after switching tabs no longer garbles the line when the app is
  busy. Keystrokes could overtake a slow terminal resize after a one-second
  limit and be drawn for the old width; they now wait until the resize is done
  (#5025).
