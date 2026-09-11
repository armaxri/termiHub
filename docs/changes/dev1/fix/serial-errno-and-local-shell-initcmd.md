### Fixed

- Serial-port open failures are now classified by the locale-invariant OS error
  code (errno on Unix, `GetLastError` on Windows) and `io::ErrorKind` rather than
  by matching English words in the OS error message. On a non-English system an
  in-use or permission-denied port previously fell through to a generic "Failed
  to open serial port" message because the OS text was localized; it now shows
  the correct "already in use by another application" / "permission denied"
  guidance regardless of the OS display language (I18N-007).
