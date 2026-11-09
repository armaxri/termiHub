### Fixed

- A local `/bin/bash` (bash 3.2 on macOS) now picks up a terminal resize made while a
  command was running, even with **Command Marks (Shell Hook)** off (#5096). termiHub
  re-sends the resize to bash once it is back at its prompt, and types nothing into the
  shell. Over SSH, a remote bash 3.2 without `checkwinsize` still keeps the old width
  until the next resize at a prompt; the setting's help text now says so.
