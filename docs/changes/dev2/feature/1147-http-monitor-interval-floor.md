### Fixed

- HTTP monitor (Network Tools): the poll interval is now clamped to a safe
  minimum (1 s) in the backend. Previously an empty or invalid interval field
  could send `0` to the backend, which forwarded it verbatim and turned the
  monitor into a tight busy-loop of HTTP requests. The interval floor is now
  enforced server-side regardless of what the UI sends (#1147).
