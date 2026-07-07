### Added

- Credential store: a low-key notification ("Credential store auto-locked after
  inactivity") now appears when the master-password store auto-locks after its
  inactivity timeout, so it's clear why the next connect will re-prompt. A manual
  lock via the status-bar indicator stays silent (it already confirms the lock),
  so there's no double notification (#1144, G7).
- Credential store: when the encrypted credentials file is corrupt (unreadable,
  malformed, or an unsupported version), the unlock dialog now offers a "Reset
  store" action to start over, instead of trapping the user in an endless
  "Incorrect master password" loop. A genuinely wrong password still shows the
  normal retry prompt (#1144, G8).

### Removed

- Removed a dead "Set Master Password" modal that was mounted but never reachable.
  Master-password setup continues to work through Settings → Security (choose
  "Master Password"), which is unchanged (#1144).
