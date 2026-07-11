### Changed

- File browser mutating and clipboard actions that previously resolved silently
  or only logged to the (user-inaccessible) console now give clear success/error
  feedback (#1399):
  - **New folder** / **New file**: creating a folder or file now shows a success
    toast, and a failure surfaces a recoverable error toast instead of only a
    `console.error`.
  - **Copy Name** / **Copy Path**: copying a file's name or path to the
    clipboard now confirms with a "Copied name" / "Copied path" toast, and a
    failed clipboard write reports the error.
  - (File **rename** already reported success/error feedback via #1348; this is
    unchanged and now covered by a regression test.)
