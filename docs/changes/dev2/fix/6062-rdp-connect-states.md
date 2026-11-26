### Fixed

- An RDP tab said "Connected, waiting for the first frame…" while its helper was still dialing, so a
  host that did not answer looked like a hang and a wrong password like a session that dropped. It now
  says "Connecting" while the helper dials, "Signing in" once the host answered, and connected only
  once the server accepted the logon. A failure before that is a connect failure with its reason and
  is not retried as a dropped session; a helper that never answers times out. A typed password is
  stored only once the logon succeeded, and Abort works while it signs in. (#6062)
