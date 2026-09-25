### Fixed

- System monitoring no longer hangs on "Connecting…" forever when the remote
  host connects but only ever answers with unparseable output (e.g. truncated
  or garbage `/proc` data). After a small number of consecutive unparseable
  samples the monitor now resolves to **Offline** with a Retry control, for
  both SSH and Docker/WSL monitoring. The same bound applies after a reconnect
  whose re-dialled host still returns unusable data (#3252).
