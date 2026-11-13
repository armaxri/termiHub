### Fixed

- Local bash / zsh older than 5.1 (macOS's `/bin/bash` 3.2) with command marks
  on: the shell-integration setup is no longer typed blind after 10 seconds
  while a slow startup file still runs, where it showed in full ahead of the
  startup output. It waits for the shell's prompt instead; past 10 seconds the
  tab shows the same "command marks (and initial command) not sent yet"
  notice, and **Send now** types the setup, then the initial command, once
  (#5564).
