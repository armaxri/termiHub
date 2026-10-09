### Fixed

- Serial: on Windows, opening a COM port that another application already holds now
  reports "Serial port is already in use by another application" instead of "Permission
  denied". The Windows permission hint now describes a real access-rights problem.
