# Changes for dev1/feature/1360-master-password-ux

### Added

- Caps Lock warning on every password field. The shared `PasswordInput` now detects
  `getModifierState("CapsLock")` and shows an assertive, screen-reader-announced
  "Caps Lock is on" indicator — covering the unlock, connect-password, and
  change-master-password flows — so an inadvertent Caps Lock no longer masquerades
  as an "Incorrect master password" or failed SSH connect (#1360).
- Forgot-password recovery in the unlock dialog. A "Forgot password? Reset credential
  store…" affordance is now always available (previously it appeared only when the
  credentials file was corrupt), giving a user who simply forgot their master password
  a clear recovery path instead of a dead-end. It is guarded by an explicit,
  irreversible confirm that spells out that all saved credentials are permanently
  deleted (#1360).

### Changed

- Switching credential storage mode away from Master Password now unlocks the store
  first when it is locked — routing through the same unlock gate as the change-password
  flow — before performing the destructive switch (#1360).
- The "None" storage-mode confirm now uses stronger, irreversible copy, making clear
  that switching permanently deletes all saved credentials and cannot be undone (#1360).
