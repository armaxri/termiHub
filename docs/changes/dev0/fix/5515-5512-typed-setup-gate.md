### Fixed

- Local zsh / bash with command marks on: answering a one-key startup question
  (`read -q`, `read -n 1`) now brings the command marks at the first prompt, and
  the connection's initial command follows them. Before, the initial command
  was typed after one second, straight into the question (#5515).
- Local bash / zsh (5.1 or later) with command marks on and bracketed paste
  turned off: the shell-integration setup and the initial command are no
  longer typed blind on a timeout. After about 10 seconds the tab shows
  "Waiting for the shell prompt — command marks and initial command not sent
  yet" (or "command marks not set up yet" without an initial command), and
  **Send now** types the setup, then the command, once (#5512).
