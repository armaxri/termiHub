### Changed

- Terminal output is now delivered only to the window that hosts the session,
  instead of being broadcast to every open window. In a multi-window setup a
  window no longer receives (and then discards) the output of sessions it is not
  showing, cutting wasted IPC and per-window decoding and keeping one window's
  session bytes off the other windows' IPC channel. Byte content, ordering, and
  scrollback are unchanged; a session not yet claimed by a window still
  broadcasts as before (PERF-004).
