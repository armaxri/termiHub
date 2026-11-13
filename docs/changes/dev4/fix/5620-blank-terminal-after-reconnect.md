### Fixed

- Terminal: after an automatic reconnect (an SSH jump-host tab coming back, a
  serial device being replugged) the tab turned green but its terminal stayed
  empty — no scrollback and no new prompt — although the session was live. The
  reconnect created a fresh terminal view that was never put back on screen; it
  now is, so the preserved scrollback and the new output show right away
  (#5620).
