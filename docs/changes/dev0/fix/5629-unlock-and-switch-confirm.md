### Fixed

- A wrong master password in the unlock dialog now shows as an error on the
  password field (red border, message under it). The Unlock button stays the
  blue primary button instead of turning into a green outline (#5629).
- Switching credential storage is confirmed once, in the banner under the
  storage options, instead of also as a toast (#5629).

### Changed

- The credential-storage switch confirmations name their action ("Move to OS
  Keychain", "Delete saved credentials", "Move to Master password") and say what
  happens to your saved credentials and the master-password vault: a move copies
  them and keeps the source (the vault stays on this computer, locked), and
  turning storage off deletes them (#5629).
