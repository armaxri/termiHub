### Fixed

- Sudo edits on SSH files opened via the session path again name the host
  (`user@host:port`) in the sudo-password prompt and namespace the optional
  "remember my sudo password" credential-store entry per host, instead of
  falling back to the file path. The host label lost its source when the legacy
  `sftpSessionId` model was retired (#2422); it is now sourced from the owning
  terminal tab's connection config, reconnect-stable, and byte-identical to the
  label the legacy SFTP path used, so sudo passwords saved before the
  sftp→session convergence still resolve (#2424, #2426).
