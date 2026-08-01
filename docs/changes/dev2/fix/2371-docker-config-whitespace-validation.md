### Fixed

- Docker connection validation now rejects malformed configs up front with a
  clear error instead of letting them fail deep in the container runtime: a
  whitespace-only image, env-var key, or volume path is treated as empty, and an
  environment-variable key containing `=` (which would silently corrupt the
  container's environment) is rejected. Brings Docker validation to the same bar
  as SSH and serial (#2371).
