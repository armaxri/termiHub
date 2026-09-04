### Added

- HTTP monitors can now run on a connected agent. A new "Run on" selector on the
  HTTP Monitor panel lets you choose whether a monitor polls its target from this
  computer (the default, unchanged) or from a remote agent's vantage point. An
  agent-hosted monitor streams its checks back through the same panel, so it looks
  and behaves exactly like a desktop-hosted one — matching how embedded HTTP/FTP/
  TFTP servers already offer an agent as a run location (#2592, part of #2139).
