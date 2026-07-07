### Fixed

- Changing the master password while the credential store is locked no longer
  dead-ends. Clicking **Change Master Password** in Settings → Security while the
  store is locked now opens the unlock flow first and proceeds to the change
  dialog only after a successful unlock, instead of surfacing a raw "Store is
  locked — cannot change password" error with no way to unlock. Cancelling the
  unlock aborts without opening the dialog, and a tooltip explains the gate
  (#1144).
