### Changed

- **SSH X11 forwarding now uses the standard `x11-req` request**, like
  OpenSSH's `ssh -X`: the SSH server sets `DISPLAY` and runs `xauth` itself,
  so nothing is typed into the remote shell, on every login shell including
  PowerShell and Windows hosts. The server only sees a random stand-in cookie;
  termiHub swaps in your real X server cookie locally and refuses any X11
  connection that does not carry the stand-in. A server with
  `X11Forwarding no` still gets the previous typed `DISPLAY` setup as a
  fallback; the connect status and the log say which mode is active (#5570).
