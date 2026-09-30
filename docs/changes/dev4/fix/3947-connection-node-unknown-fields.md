### Fixed

- Saved connections, folders and remote agents no longer lose settings added by
  a newer version of termiHub. Previously, opening a connections file written by
  a newer version and then editing any connection, folder or agent re-saved the
  file without the per-entry fields this version did not recognise. Those fields
  are now kept as-is, including in external connection files and when a
  connection is moved between files.
