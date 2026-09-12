---
id: PARITY-007
title: Mid-connect cancellation implemented only by SSH
angle: connection-parity
severity: medium
category: reliability
is_workaround: false
subsystem: core/src/connection
evidence:
  - core/src/connection/mod.rs:151
  - core/src/backends/ssh/mod.rs:567
status: open
---

## What

`ConnectionType::connect_cancellable(settings, cancel)` lets a caller abort an in-flight connect via
a `CancellationToken` (added for #952). The trait provides a default that **ignores the token** and
delegates to plain `connect()`. Only **SSH** overrides it. Every other backend — Docker, FTP,
telnet, VNC, RDP, local, serial, WSL — inherits the default, so their connects cannot be aborted
until the underlying operation returns on its own.

## Why it matters

- The UI offers a "Cancel" affordance on a connecting tab (that is what #952 wired up), but for
  every non-SSH backend that cancel cannot actually interrupt the slow part of the connect:
  - **Docker:** the image pull + container create/start ignore the token.
  - **FTP:** the TCP connect / TLS negotiation / login ignore the token (there is a connect
    *timeout*, but no responsive cancel).
  - **VNC/RDP:** transport + TLS + auth negotiation ignore the token.
- So "Cancel connect" is a first-class, responsive action on SSH and a no-op-until-timeout on
  everything else — an invisible behavioural inconsistency on a common path.

## Evidence

- `core/src/connection/mod.rs:151` — default `connect_cancellable` "ignores the token and delegates
  to `connect`; backends that support mid-connect cancellation (SSH) override it."
- `core/src/backends/ssh/mod.rs:567` — the sole override; a repo search for
  `fn connect_cancellable` across `core/src/backends` returns only `ssh/mod.rs`.

## Recommendation

Thread the token through the slow connect stages of at least Docker and FTP (both have obvious
cancellation points: the pull stream / the TCP+TLS+login steps can be raced against
`cancel.cancelled()` with `tokio::select!`). Where a backend truly cannot cancel, keep the default —
but the graphical and container backends, which have the longest connects, should not be the ones
silently ignoring the token.
