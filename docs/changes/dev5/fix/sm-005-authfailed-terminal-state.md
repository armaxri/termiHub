### Changed

- Authentication failures (a wrong password/passphrase or a refused key) are now
  treated as a terminal, non-retryable state instead of being retried like a
  transient network drop. Previously a genuine auth rejection would spin the
  auto-reconnect loop through all of its doomed attempts against credentials that
  can never work before finally giving up. A rejected connect now stops
  immediately and surfaces a clear "Authentication failed — check your
  credentials, then reconnect" message; the loop is never armed. Transient
  failures (network drops, timeouts, refused connections) keep their existing
  auto-reconnect behaviour unchanged (finding SM-005).
