### Fixed

- Quit (Cmd+Q, the app menu's Quit, the Dock's Quit) now also asks a window
  that opened a moment before the quit, for example a tab just torn off into
  its own window. Such a window could miss the quit request while it was still
  loading; the quit then went ahead after a few seconds and ended that window's
  live sessions without showing its "Quit termiHub?" dialog. A window that
  finishes loading during a pending quit now answers it, and the quit waits up
  to 15 seconds for a loading window before treating it as unresponsive (#5106).
