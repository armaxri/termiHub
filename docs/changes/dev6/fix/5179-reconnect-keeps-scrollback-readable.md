### Fixed

- Terminal: while a dropped session auto-reconnects, the scrollback stays
  readable. The retrying state is now a thin strip at the top of the terminal
  (countdown, attempt n of 10 and Cancel) instead of a full blurred overlay, so
  you can scroll, select and copy the last lines of output without cancelling
  the reconnect. The strip also says that typing is paused until the session is
  back, and highlights that note if you type anyway. The full overlay remains
  for the end states (attempts exhausted, authentication failed, session lost)
  (#5179).
