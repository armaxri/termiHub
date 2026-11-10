### Fixed

- Bare <kbd>F1</kbd> now reaches the program running in a focused terminal
  (htop, Midnight Commander, nano, vim help, …) instead of opening termiHub's
  keyboard-shortcuts overlay. Outside a terminal, <kbd>F1</kbd> still opens the
  overlay. The overlay's Windows/Linux default is now <kbd>Ctrl</kbd>+<kbd>F1</kbd>,
  which works from inside a terminal too (macOS keeps <kbd>Cmd</kbd>+<kbd>K</kbd>
  <kbd>Cmd</kbd>+<kbd>S</kbd>, and gains bare <kbd>F1</kbd> outside terminals).
  This follows the F6 rule that terminal programs keep plain function keys
  (#5194).
