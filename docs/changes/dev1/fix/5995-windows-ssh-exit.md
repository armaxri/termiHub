### Fixed

- SSH: a shell on a Windows SSH server (Win32-OpenSSH) that ends no longer reads "exit code 0" or
  "ended normally". The server sends 0 for such a shell whatever it exited with, so termiHub shows
  "[Process exited]" and "The session ended." without a code, and never reconnects it (#5995).
