### Added

- Telnet connections now expose a configurable **Connect Timeout (s)** setting,
  matching the option SSH already had. It bounds how long a connect to an
  unreachable telnet host blocks before failing; leaving it empty uses the
  default 10 s (the previous fixed behavior), so existing saved connections are
  unaffected (PARITY-006).
