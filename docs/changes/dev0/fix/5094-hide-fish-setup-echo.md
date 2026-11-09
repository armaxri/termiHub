### Fixed

- SSH: on a fish login shell, termiHub's typed session setup (configured
  environment variables, the X11 `DISPLAY` / `xauth` lines, and fish 3's
  shell-integration hook) is now hidden, as it already was on bash and zsh. It
  no longer shows in the terminal, in the tab title, or in fish 4's command
  mark. The login banner and MOTD still show, and nothing is written to fish's
  history or rc files. fish redraws typed input cell by cell; termiHub now
  follows that redraw with a small screen model, and if it sees anything other
  than its own line, it shows everything unchanged (#5094).
