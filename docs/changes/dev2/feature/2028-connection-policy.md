### Added

- Plugin capability bridge: per-session **connection policy**. The
  `PluginHostBridge` now enforces a per-session ceiling on how many mediated
  connections a plugin may hold open at once (refusing further `open_connection`
  calls with a permission denial once the ceiling is reached), and the mediated
  connect timeout — previously a hardcoded 30s constant — is now configurable.
  Both default to host values (8 concurrent connections, 30s timeout) and can be
  raised or lowered per plugin through a new optional `connectionPolicy`
  (`maxConnections`, `connectTimeoutMs`) block in `manifest.json`. This closes
  the resource-exhaustion gap left by #2024: a cooperating plugin can no longer
  open unbounded connections through the bridge or hang a session on a slow
  dial-out. The plugin ABI stays at version 3 — the policy is enforced entirely
  host-side (#2028).
