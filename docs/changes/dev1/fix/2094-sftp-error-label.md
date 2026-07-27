### Fixed

- SFTP file-browser operation failures now surface with an `SFTP error:` prefix
  instead of the misleading `SSH error:` prefix. Previously a file-transfer
  failure showed e.g. `SSH error: readdir failed: …` even though it was an SFTP
  operation, not a shell/SSH-session failure. Genuine SSH exec-channel failures
  (used by the elevated-save path) keep their `SSH error:` label (#2094).
