### Fixed

- Resilient direct-SSH terminal tabs no longer flip to "Failed" while the backend
  is still legitimately reconnecting. The client's fixed 90 s wall-clock connect
  deadline was racing the backend reconnect loop and could force-fail a tab the
  backend would have recovered; the deadline now defers to the backend's
  authoritative give-up for every resilient tab (agent and direct SSH alike).
  Non-resilient connects keep the wall-clock safety net so a genuinely stuck
  connect can never spin forever (SM-004).
