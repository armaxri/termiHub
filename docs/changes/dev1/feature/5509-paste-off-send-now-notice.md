### Added

- Local shells: when bash or zsh (5.1 or later) has bracketed paste turned off,
  the connection's initial command waits for a prompt the shell never
  announces. After about 10 seconds the tab now shows "Waiting for the shell
  prompt — initial command not sent yet" with **Send now** (types the command
  once) and **Hide**, instead of waiting silently. The command is still never
  typed on its own, and the notice clears if the prompt comes after all
  (#5509).
