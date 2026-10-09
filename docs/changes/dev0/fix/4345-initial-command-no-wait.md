### Fixed

- Terminal: a connection with an initial command no longer shows a blank
  terminal for about 5 seconds on macOS and Linux. Output now appears as soon
  as the shell prints it. The initial command is typed once the shell has drawn
  its first prompt (detected through termiHub's shell integration), or after
  1 second for shells without it, and a failed send is now logged (#4345).
