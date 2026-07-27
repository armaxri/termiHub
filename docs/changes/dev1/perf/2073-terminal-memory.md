### Fixed

- Terminal memory growth over long-running sessions. Pre-subscribe terminal
  output is now dropped when its session exits and is capped to 256 KiB per
  session (oldest bytes discarded past the ceiling), so a session that produces
  a lot of output before — or without — a tab attaching can no longer leak its
  buffer. The optional syntax-highlighting engine now releases each line's
  decoration bookkeeping when the line scrolls out of the scrollback, so its
  internal map no longer grows without bound over a long session.
