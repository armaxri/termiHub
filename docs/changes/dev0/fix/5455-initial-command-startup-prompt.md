### Fixed

- Local shells: a connection's initial command (without command marks) could be
  typed into a question that bash or zsh asks during startup, such as zsh's
  `compinit` "Ignore insecure directories and continue [y]?", so its first
  character became the answer and the rest ran as a mangled command. For bash
  and zsh from 5.1, the initial command now waits until the line editor
  announces a fresh command line (bracketed paste on), for as long as the
  question stays open, and is sent once the user has answered. Shells without
  that signal (macOS's `/bin/bash` 3.2, fish, others) keep the previous timing
  (#5455).
