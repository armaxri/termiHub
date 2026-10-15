### Added

- **Crash reports list every loaded module**: a crash report now ends with a `modules:`
  section naming each library the process had loaded (file name only, never a path) with
  its load address, size and build id, so every backtrace address, including frames in
  system libraries, the WebView or a native plugin, can be attributed to a module and an
  offset and symbolized with that module's symbols (#4795).
