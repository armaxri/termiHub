# Changes

## Fixed

- **Passwords are no longer shell/env-expanded.** A stored password containing
  `$`, `${VAR}`, or a leading `~` was previously run through shell-style
  expansion when a connection was opened, silently rewriting the secret — an
  unknown variable expanded to nothing (deleting characters) and a leading `~`
  became a home path, so authentication could fail with no visible cause. Worse,
  a `${VAR}` embedded in a password expanded to the desktop process's
  environment value and was then sent as the credential to the remote host.
  Passwords are now used verbatim across SSH, FTP, SSH jump hosts, and remote
  agent connections. Non-secret fields (host, username, key-file path, initial
  directory) still support `${VAR}` / `~` expansion as before.
