### Fixed

- SSH tunnels: starting a tunnel for a connection whose shared SSH session had
  just died no longer fails straight into `Error` by adopting the dead pooled
  session. The endpoint (and jump-host gateway) pool now evicts a dead cached
  session on acquire and dials a fresh one instead.
