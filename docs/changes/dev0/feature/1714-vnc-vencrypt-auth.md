### Added

- VNC: the SSH-tunnel option now supports **key-file** and **ssh-agent**
  authentication in addition to a password. A new "SSH Auth Method" field in the
  connection editor's SSH Tunnel group selects between Password, Key File, and
  SSH Agent; the Key File method reveals a key-path picker, and the password
  field doubles as the key passphrase. Tunnel auth reuses the SSH backend's
  existing russh auth methods, so keys, passphrase-protected keys (including
  legacy-PEM EC keys), and the local agent all work the same way they do for a
  direct SSH connection. Part of #1714.
