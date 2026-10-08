### Changed

- VNC: when the SSH connection a direct VNC connection links as its file route has no saved
  password or key passphrase (or the credential store is locked), opening **Files**, dropping
  files or clicking **Retry** now asks for it with the usual password prompt (or unlocks the
  store), with **Save password** as in a normal connect. The entered secret is kept for the VNC
  session only; starting the session and resuming transfers after a restart never ask (#4265).
