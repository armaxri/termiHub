## Fixed

- Aborting an SSH connection with X11 forwarding on macOS while XQuartz is still starting up now
  stops immediately, instead of waiting out the full (~4s) XQuartz readiness budget before the
  abort takes effect. The connect-abort signal is now threaded into the XQuartz readiness wait.
