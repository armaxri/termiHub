### Fixed

- Local shells: with command marks (shell integration) on, a question that bash
  or zsh asks during startup — zsh's `compinit` "Ignore insecure directories and
  continue [y]?", a framework's update prompt, a `read -n 1` in an rc file — was
  answered by termiHub's typed setup line, and the rest of that line could run
  as a mangled command. For bash and zsh from 5.1, the setup now waits until the
  line editor announces a fresh command line (bracketed paste on), so a startup
  question is left to the user; keys the user types before the prompt run first,
  and the setup follows at the next prompt. Older bash (macOS's `/bin/bash` 3.2)
  keeps the previous timing (#5452).
