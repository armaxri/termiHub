### Fixed

- Terminals (local shell, SSH, Docker, WSL, telnet, and the same types on an
  agent) now start at the size of the terminal pane instead of 80x24 and being
  resized a moment later, so the shell's first prompt and the working-directory
  line-erase are laid out for the real width (#4102).
