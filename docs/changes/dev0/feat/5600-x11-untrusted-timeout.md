### Added

- **Configurable untrusted X11 timeout.** With untrusted X11 forwarding on, a
  new "Untrusted X11 timeout (min)" setting chooses how long after connecting
  new remote windows can open: leave it empty for the default 20 minutes, set
  up to 1440 minutes (one day), or 0 for no limit. Windows that are already
  open keep working after the timeout (#5600).
