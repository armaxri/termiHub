### Fixed

- **VS Code file actions** no longer fail silently (#1342):
  - A remote file edited in VS Code that fails to re-upload now shows a
    recoverable error toast instead of losing the save with no feedback, and a
    successful re-upload is confirmed with a toast.
  - "Open in VS Code" now reports a launch failure with an error toast instead
    of only logging to the (user-inaccessible) console.
