### Fixed

- A corrupt remembered-host-keys file (SSH or RDP) that could not be backed up is
  now protected by the same save guard as every other settings file, so nothing
  can overwrite the only copy. Repairing the connections or embedded-servers file
  while termiHub is running and reloading it now lifts that guard straight away
  instead of only after a restart (#4466).
