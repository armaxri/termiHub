---
id: DUP-012
title: Core session transport traits are half-adopted — ProcessSpawner unused, ProcessHandle agent-only
angle: code-duplication
severity: medium
category: arch
is_workaround: true
subsystem: core/session/traits.rs
evidence:
  - core/src/session/traits.rs:65
  - core/src/session/traits.rs:108
  - agent/src/daemon/client.rs:327
status: open
---

## What

The `core::session::traits` module documents `ProcessSpawner` + `ProcessHandle` as the seam that
unifies "PTY spawn (desktop) vs daemon spawn (agent)". In reality `ProcessSpawner` has **zero
implementers** anywhere in the tree, and `ProcessHandle` is implemented **only** by the agent's
`DaemonClient` and is never consumed generically by the desktop. The session managers never route
through either.

## Why it matters

This is dead/aspirational abstraction masquerading as the shared seam. It actively misleads: a
reader trusts the docstring that spawning is unified, when the two managers (DUP-010) actually
hand-roll their own paths. `is_workaround: true` because it is scaffolding left in "just in case"
that hides the fact the intended centralization never landed.

## Evidence

- `core/src/session/traits.rs:65` — `trait ProcessSpawner` (no implementers).
- `core/src/session/traits.rs:108` — `trait ProcessHandle` (only impl: agent `DaemonClient`).
- `agent/src/daemon/client.rs:327` — the sole `ProcessHandle` impl.

## Recommendation

Either wire the desktop and agent session managers through these traits as part of the DUP-010/
DUP-011 consolidation (making them real), or delete `ProcessSpawner` and correct the module
docstring so it no longer claims a seam that does not exist.
