### Fixed

- With **Command Marks (Shell Hook)** on, bash now picks up a terminal resize that
  happened while a command was running (#5035). macOS's `/bin/bash` (3.2) kept the old
  width until the next resize at a prompt, so a long command line wrapped at the wrong
  column and overwrote the start of its row. The hook now turns on bash's `checkwinsize`
  option.
