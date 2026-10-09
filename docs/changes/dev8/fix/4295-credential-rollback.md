### Fixed

- Credentials: a master-password change that fails to save (for example on a full disk) no longer
  leaves the vault half-switched. The store keeps working with the old password, and the next saved
  credential no longer silently re-encrypts the vault under the password that was reported as
  rejected (#4295).
- Backup: when a restore cannot be applied at the next start and is rolled back, the credentials it
  imported are now rolled back too for the master-password store. If they cannot be (OS keychain, or
  credentials changed after the restore), the warning now says the backup's credentials were kept
  instead of claiming nothing changed (#4295).
