### Fixed

- Terminal: a Disconnect or Open Connections kill that fails no longer leaves the
  session flagged as user-killed, so a later real connection drop still
  auto-reconnects instead of being shown as a user disconnect. With several
  windows open, a window no longer re-drives another window's reconnecting tabs
  (#4388).
