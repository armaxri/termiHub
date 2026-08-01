### Fixed

- The encrypted credential store (`credentials.enc`) now writes durably: the
  envelope is flushed to disk (`sync_all`) before the atomic rename, so a crash or
  power loss right after the rename can no longer leave a zero-length or
  partially-written credentials file behind on reboot. The store now saves through
  the same shared atomic-write helper as the other config stores; on Unix the
  credentials file is also created owner-only (mode 0600) rather than
  world-readable (#2324).
