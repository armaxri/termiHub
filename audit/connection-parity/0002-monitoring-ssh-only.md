---
id: PARITY-002
title: System monitoring is SSH-only despite a generic capability flag
angle: connection-parity
severity: high
category: missing-feature
is_workaround: false
subsystem: core/src/backends
evidence:
  - core/src/backends/ssh/mod.rs:552
  - core/src/backends/docker/mod.rs:927
  - core/src/backends/local_shell.rs:413
  - core/src/backends/ssh/monitoring.rs:325
status: open
---

## What

Only the SSH backend reports `monitoring: true` and returns a real `MonitoringProvider`
(`SshMonitoringProvider`). Every other terminal backend — local shell, Docker, WSL, serial, telnet
— reports `monitoring: false` and hard-returns `monitoring(): None`. The only other implementor is
`RemoteMonitoringProxy`, which proxies an SSH-hosted monitor over the agent transport.

## Why it matters

- `Capabilities.monitoring` exists precisely so the UI can offer a metrics panel per connection.
  In practice it is on for exactly one backend, so the abstraction buys nothing.
- The gap is not protocol-inherent. **Local shell** and **WSL** run on a host termiHub can already
  read stats from (the app ships a `system_monitor_projection` and `core/src/monitoring` parsers).
  **Docker** exposes per-container stats via the same bollard client already held in
  `ConnectedState` (`docker stats` / `/containers/{id}/stats`). None of these are wired.
- The result is an inconsistent product surface: a user gets CPU/mem graphs for an SSH host but not
  for a local shell or a Docker container on the same machine, for no reason the user can see.

## Evidence

- `core/src/backends/ssh/mod.rs:552` — SSH is the only `monitoring: true`.
- `core/src/backends/docker/mod.rs:927` — `fn monitoring(&self) -> Option<...> { None }` with a
  test `monitoring_always_none`.
- `core/src/backends/local_shell.rs:413` — `monitoring: false`.
- `core/src/monitoring` + `src-tauri/src/system_monitor_projection` — parsers/projection exist but
  are not exposed as a `MonitoringProvider` for the local/docker backends.

## Recommendation

Implement `MonitoringProvider` for at least local shell (reuse the existing
`system_monitor_projection` collectors) and Docker (bollard stats stream), flipping their
`monitoring` flag on. Where a protocol genuinely cannot provide stats (serial, telnet), keep the
flag off — that is a legitimate `n/a`, not a gap. This turns the capability flag into a real,
uniformly-honoured contract.
