### Changed

- Remote agents with **Allow agent self-update** enabled now automatically apply
  a staged, SHA-256-verified update once they become idle (their last session
  closes), instead of only staging it and waiting for a manual apply. The apply
  reuses the deferred exec-replace mechanism, so it never interrupts active
  sessions and persistent daemon sessions survive the restart. The connection's
  **Update Strategy** is honored: `immediate`/`deferred` auto-apply on idle,
  while `coordinated` stages and notifies only. A failed apply keeps the staged
  update so a later cycle retries; a successful apply clears it and the agent
  comes back on the new version.
