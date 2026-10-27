### Fixed

- Keys typed quickly into a terminal now always reach the shell in the order
  they were typed. On a busy machine (seen on Windows) two keystrokes could
  swap, so `echo` arrived as `ceho`: each keystroke was its own call to the
  backend, and the backend could run two of them at once. A keystroke is now
  sent only after the one before it has been delivered (#4993).
- The terminal copy shortcut (Ctrl+Shift+C on Windows) no longer also opens
  the developer tools' "inspect element" mode in builds that include them
  (#4993).
