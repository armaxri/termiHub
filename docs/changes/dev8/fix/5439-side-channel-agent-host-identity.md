### Fixed

- File browser: the guard against pasting a file onto itself through another
  session now also covers a remote desktop's file browser (over its SSH tunnel
  or linked SSH connection) paired with an SSH session to the same server, and
  an agent's local session paired with an SSH session to the agent's host
  (#5439).
