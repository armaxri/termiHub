### Changed

- Shell integration no longer prints its setup at the start of a terminal session
  (#5009). In local bash and zsh sessions, and in SSH sessions to POSIX hosts, the
  setup is typed once the shell's prompt is up and its echo is kept off the screen;
  the first prompt appears once, and the MOTD, login banner and your own startup
  output stay exactly as before. fish gets the setup as a startup option instead. If
  anything other than the setup's own echo shows up where it ran (an error, other
  output), nothing is hidden. WSL and Windows Git Bash sessions still show the setup
  for now.
