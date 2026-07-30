### Fixed

- SSH tunnels: restored the transient failure toast on a first-connect
  `Start`/`Reconnect` error, lost when those became fire-and-forget in the
  tunnels projection migration. The toast is now driven from the projected
  status transition (the tunnel reaching `error` shortly after the client's own
  start/reconnect) and is scoped to the initiating client, so a mid-session
  tunnel death or another client's start still surfaces only as the Error status
  badge. The success/validation toasts and the Error badge/tooltip are unchanged.
