### Fixed

- System monitoring: hosts whose `/proc/meminfo` lacks a `MemAvailable` line
  (Linux kernels older than 3.14, and some minimal `/proc` implementations) no
  longer report a constant 100% memory usage. Available memory is now estimated
  from `MemFree + Buffers + Cached + SReclaimable` — the same approximation
  `free`/`htop` use — when the kernel does not report `MemAvailable` directly
  (#2322).
