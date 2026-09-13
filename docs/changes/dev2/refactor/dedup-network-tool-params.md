### Changed

- The built-in ping-sweep tool now resolves reverse-DNS hostnames by default and
  uses a default concurrency of 64, matching the behavior already used by the
  desktop app. Previously the shared tool wrapper (used when a ping sweep runs on
  a remote agent) defaulted to no hostname resolution and a concurrency of 100.
