### Fixed

- A WSL shell tab now shows the shell's real exit status when it ends on its
  own: `exit 3` writes "[Process exited with code 3]" instead of "[Process
  exited]", and the tab ends even where Windows did not report the end of its
  output. A non-zero exit is never reconnected, as for local shells.
