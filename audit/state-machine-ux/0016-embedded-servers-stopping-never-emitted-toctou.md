---
id: SM-016
title: Embedded servers never emit Stopping; synchronous stop creates a Stop-then-Start port TOCTOU
angle: state-machine-ux
severity: low
category: bug
is_workaround: false
subsystem: core/src/embedded_servers
evidence:
  - core/src/embedded_servers/config.rs:60
  - core/src/embedded_servers/service.rs:344
  - core/src/embedded_servers/service.rs:203
status: open
---

## What
`ServerStatus`/`ServiceStatus` defines a `Stopping` state (`config.rs:60`) that is **never
emitted** for embedded servers. `shutdown` (`service.rs:344-363`) jumps `Running → Stopped`
synchronously before the OS socket is actually released.

## Why it matters
- **TOCTOU on rapid Stop-then-Start:** the UI shows `Stopped` while the port is still held by
  the closing listener; an immediate Start hits `check_port_config` (`service.rs:203-220`)
  and fails with "port in use", confusing the user who just stopped it.
- **No transient feedback:** long teardown (e.g. TFTP with in-flight transfers) shows no
  "Stopping…" state — the row flips straight to Stopped while work is still draining.

## Evidence
- `config.rs:60` — `Stopping` variant exists.
- `service.rs:344-363` — `shutdown` folds `Stopped` synchronously, pre-socket-release.
- `service.rs:203-220` — `check_port_config` fails if the socket is not yet freed.

## Recommendation
Emit `Stopping` during teardown and only fold `Stopped` once the listener socket is confirmed
released (await close), closing the Stop-then-Start race and giving the row honest transient
feedback.
