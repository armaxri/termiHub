### Fixed

- File browser: on a Windows SSH server with Git Bash as its login shell and Command Marks (Shell
  Hook) on, the browser now follows `cd` into drive folders such as `/c/Users/me`, which the
  server's SFTP names `/C:/Users/me` (#6147).
