---
id: AGT-026
title: The reconnect dead-socket fast-fail and detach ordering are only regression-tested on unix — the Windows named-pipe path is uncovered
angle: agent-protocol
severity: low
category: test-gap
is_workaround: false
subsystem: agent/src/daemon/transport.rs
evidence:
  - agent/src/daemon/transport.rs:489
  - agent/src/daemon/transport.rs:337
status: open
---

## What
The #2476/#2491 dead-but-lingering-socket fast-fail (2 s recovery connect timeout) and its
regression test are `#[cfg(unix)]`-gated (`agent/src/daemon/transport.rs:489`). The Windows
`WaitNamedPipeW` dead-endpoint path (`agent/src/daemon/transport.rs:337`) has no equivalent
test. Persistent sessions ship on Windows, so the reconnect hot path there is unverified for
the very failure mode (a dead endpoint that hangs the connect) the unix fix addresses.

## Why it matters
The stuck-reconnect class of bug (30s hang) was a real, user-visible defect on unix; the
Windows path relies on a different primitive (`WaitNamedPipeW` vs socket connect timeout)
with no regression coverage, so a regression there would ship silently.

## Evidence
- `agent/src/daemon/transport.rs:489-597` — `#[cfg(unix)]` regression test only.
- `agent/src/daemon/transport.rs:337-347` — Windows `WaitNamedPipeW` path, untested for the
  dead-endpoint case.

## Recommendation
Add a Windows-equivalent dead-endpoint fast-fail test (a named pipe that is bound-then-dead),
or document why the `WaitNamedPipeW` timeout makes the fast-fail inherently covered.
