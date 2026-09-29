### Fixed

- Switching the credential storage mode now rolls back when it fails
  completely. If none of your credentials can be moved to the new store, the
  previous store stays active (still unlocked, with no new password prompt), the
  new mode is not saved, and Settings reports "Switch failed, nothing changed".
  A partial migration still switches and lists what could not be moved.
- Switching the credential storage mode to **None** now deletes the saved
  credentials from the previous store, as the confirmation dialog promises.
  Before, they stayed on disk. Settings now reports how many credentials were
  removed instead of "migrated", and lists any entries that could not be
  removed.
