### Changed

- Saving an SSH tunnel now confirms with a success toast ("Saved tunnel …"),
  matching the feedback already given by Duplicate, Delete, and Start — previously
  a plain Save resolved silently, with the tab merely closing as the only signal
  (UX-022).
- The tunnel editor's Save actions are now disabled while the tunnel name is
  blank, instead of silently persisting it as "Untitled Tunnel" — matching how the
  connection editor gates Save on a non-empty name (UX-022).
- Starting or reconnecting a tunnel now keeps its "Starting …" / "Reconnecting …"
  toast pending until the tunnel actually connects, resolving to success only on
  the real connected transition (or to a failure toast if the handshake fails).
  Previously the green "Started" appeared a beat early, when the backend merely
  accepted the request — occasionally just ahead of the actual connection-failure
  toast (UX-023).
