### Fixed

- Terminal: with a plugin protocol parser active, the "[Process exited…]" line
  could still be written above output the parser had not returned yet. It now
  waits for that output, so it is always the last line of an ended session
  (#5965).
