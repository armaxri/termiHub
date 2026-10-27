### Fixed

- A new terminal tab no longer garbles a long command line. A tab that connected
  before its panel was laid out briefly sized its shell to 2 columns; on macOS
  bash redrew its line for that width, so the next prompt overwrote the end of
  the line and shell integration (command marks) did not set up. Terminals are
  no longer sized until their panel has a real size (#5025).
