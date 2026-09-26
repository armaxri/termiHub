### Added

- **Unlock with Touch ID / Windows Hello**: the master-password credential
  store can now be unlocked with biometrics. Turn it on in Settings → Security →
  Master Password Options (shown only where the system supports it); it needs
  your master password once. The unlock dialog then offers Touch ID / Windows
  Hello first, and the master password always keeps working. Biometric unlock
  turns itself off when you change the master password, switch storage modes,
  or (on macOS) add or remove a fingerprint (PROD-064).

### Changed

- Exporting credentials from the OS keychain — the credential vault export and
  the credentials part of a backup — is available again on macOS and Windows:
  every export asks you to confirm with Touch ID / your Mac password or Windows
  Hello first, and is refused if you cancel. On Linux it stays unavailable
  because there is no system way to confirm it is you (#3433).
