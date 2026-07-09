# Changes

## Fixed

- HTTP monitors now persist across app restarts. A monitor's configuration (URL,
  interval, method, expected status, timeout) is saved to disk when started and
  removed when stopped, and every saved monitor is automatically restarted when
  the app launches — previously all configured monitors silently disappeared on
  restart. (#1147)
