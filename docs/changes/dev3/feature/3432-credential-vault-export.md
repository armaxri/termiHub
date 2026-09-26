### Added

- **Credential vault export / import** (PROD-063, #3432): Settings → Security → Credential Vault
  Backup can now export every saved password and key passphrase to an encrypted file protected by
  an export passphrase (entered twice, at least 12 characters, separate from the master password),
  and import such a file into the current credential store. Export requires re-entering the master
  password; the import shows a preview of new and conflicting credentials and lets you keep or
  replace existing ones. Imports are all-or-nothing — a wrong passphrase or a modified file changes
  nothing.
  Export is available in Master Password mode; in OS Keychain mode it is disabled until
  system authentication is supported (#3433), while importing into the keychain works.
