### Fixed

- Agent: persistent remote-agent sessions now survive an SSH disconnect and can be
  re-attached after reconnecting. The session daemon was being killed when the SSH
  connection dropped (it stayed in the SSH login session and inherited the SSH channel's
  stderr); it is now fully detached from the connection, so reconnecting re-lists and
  re-attaches the still-running session (#995).
