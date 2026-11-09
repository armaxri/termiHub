### Fixed

- Closing a window or quitting termiHub while a connection is still starting
  (for example a slow SSH, serial or agent connection that has not finished
  connecting) no longer ends it without a word. The "Close this window?" and
  "Quit termiHub?" dialogs now list such a tab as still starting, and say it
  will be ended. A connection that finishes connecting after you confirm is
  closed straight away instead of being left running in the background (#5112).
