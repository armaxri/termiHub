### Fixed

- Persistent sessions: starting a persistent session of a saved connection now
  uses the secrets saved for it beyond the main password — such as an inline
  jump host's password or a plugin's password field — just like opening a
  regular session does. When the credential store is locked, or credential
  storage is off, you are asked to unlock it or enter the secret instead of the
  session connecting without it (#4454).
