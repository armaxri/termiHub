### Fixed

- A tunnel hosted on an SSH connection from an external connection file now
  starts instead of failing with "SSH connection not found". The tunnel's SSH
  connection resolves against the same connections the Tunnel editor offers,
  under the same rule as saved-connection jump hosts (#3619).
- An SSH connection whose id exists in more than one connection file is shown
  as unavailable in the Tunnel editor, and a tunnel bound to it fails with a
  message naming the files. An SSH connection in a disabled external connection
  file fails with a message naming that file.
