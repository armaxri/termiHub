### Fixed

- Backend-driven agent reconnect (`sessionBackendReattach`) now arms the reconnect
  redrive from its own authoritative source. When a resilient agent session drops,
  the server-side drop fold marked the tab "Reconnecting" but did not arm the
  backend reconnect timer (every `session.*` intent route does; the source-side
  fold did not), so the backend redrive relied solely on the client's
  `session.reconnect` mirror to start its own loop. The drop fold now reconciles
  the timer itself, so the backend is the sole driver of an agent reconnect as
  designed and a resilient drop cannot leave a tab stuck "Reconnecting" with no
  attempt ever driven.
