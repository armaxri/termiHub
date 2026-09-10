### Fixed

- A remote SSH command killed by a signal (e.g. an OOM/SIGKILL or a `sudo`
  file write interrupted mid-write) is no longer misreported as a success.
  The exec drain only handled SSH `exit-status` and let `exit-signal` fall
  through, so a signalled death kept the default exit status of `0` — which
  the privilege-elevated write path and the exec-capability probe both read as
  success. A signal-killed command now reports a non-zero `128 + signum`
  status and records the signal name, so an interrupted privileged write is
  correctly surfaced as a failure.

### Changed

- SSH command execution is now bounded by a 60-second timeout. A half-dead
  server that opens the exec channel but never closes it previously hung the
  capability probe and elevated-write callers indefinitely; they now fail with
  a timeout error instead of blocking forever.
