### Fixed

- The connect-time credential prompt no longer mislabels an SSH **key
  passphrase** as the account's "SSH Password". When a passphrase-protected
  private key is being unlocked, the dialog title, description, input
  placeholder, accessible name, and the "Save…" checkbox now say "passphrase"
  rather than "password"; the genuine account-password prompt is unchanged
  (UX-010).
