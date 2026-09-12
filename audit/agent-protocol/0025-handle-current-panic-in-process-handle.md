---
id: AGT-025
title: ProcessHandle sync methods call Handle::current() and will panic if ever invoked outside a Tokio runtime
angle: agent-protocol
severity: low
category: reliability
is_workaround: false
subsystem: agent/src/daemon/client.rs
evidence:
  - agent/src/daemon/client.rs:329
status: open
---

## What
The sync `ProcessHandle` impl calls `tokio::runtime::Handle::current()`
(`agent/src/daemon/client.rs:329`, `:347`, `:367`), which **panics** if called outside a
Tokio runtime. The doc comment asserts the invariant that these are only called from
`spawn_blocking` (where a handle exists). If that invariant is ever violated by a future call
site, the agent panics rather than returning an error.

## Why it matters
On a safety-critical build, an invariant enforced only by a comment is a latent panic. The
blast radius is a crashed worker/daemon.

## Evidence
- `agent/src/daemon/client.rs:322-367` — `Handle::current()` in the sync path, guarded only
  by documentation.

## Recommendation
Use `Handle::try_current()` and return a graceful error (or store a cloned `Handle` at
construction) instead of relying on the ambient runtime and panicking on its absence.
