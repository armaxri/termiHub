### Added

- SSH agent forwarding: a new **Forward SSH agent** toggle in the SSH section of
  the connection editor (OpenSSH `ForwardAgent`). When enabled, the local
  `ssh-agent`'s keys are made available on the target host — and, because the
  forwarded-agent channel rides the jump-host tunnel, end to end through the
  `ProxyJump` chain — so onward SSH and git-over-bastion work without copying
  private keys onto intermediate hosts. Off by default; existing saved
  connections are unchanged. When no local agent is running
  (`SSH_AUTH_SOCK` unset, or the Windows OpenSSH agent stopped) the option is a
  no-op and the connection still succeeds (#1699).
