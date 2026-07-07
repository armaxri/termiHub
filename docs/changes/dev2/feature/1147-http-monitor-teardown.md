### Fixed

- HTTP monitor (Network Tools): running monitors are now torn down cleanly when
  the app exits. On quit, every monitor's poll loop is cancelled and any
  in-flight HTTP request is aborted, matching how SSH tunnels, embedded servers,
  and the managed X server already shut down. Previously the poll tasks were only
  cancelled on an explicit Stop and otherwise just died with the process,
  abandoning in-flight requests. Addresses gap #3 of the HTTP monitor audit
  (#1147).
