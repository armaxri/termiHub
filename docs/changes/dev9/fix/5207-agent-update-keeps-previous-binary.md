### Fixed

- Agent update no longer leaves a host with no working agent when the new
  binary fails to start (for example a wrong libc, a truncated upload, or a
  build that crashes). The previous agent is now kept as a backup during the
  update, put back if the new binary fails its `--version` check, and proven
  to run again. The Update dialog then reports that the update failed and
  names the agent version that is still running. This applies to POSIX hosts
  and to Windows hosts (cmd and PowerShell). If a deploy is interrupted
  between the backup and the check, the next deploy restores the backup when
  the installed binary does not run, instead of deleting it (#5207).
