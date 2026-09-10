---
id: CORE-020
title: Backends rely on explicit disconnect() with no Drop guard — leaks on panic/early return
angle: backend-core-rust
severity: medium
category: reliability
is_workaround: false
subsystem: core/backends
evidence:
  - core/src/backends/local_shell.rs
  - core/src/backends/docker/mod.rs
status: open
---

## What
Session cleanup (kill process, close PTY, stop/remove container, close sockets)
is driven entirely by an explicit `disconnect()`; the connected-state structs do
not implement `Drop`. If a `ConnectedState` is dropped without `disconnect` being
called — a panic between spawn and store, an early `?` return, or a manager that
forgets to call it — the underlying OS resource leaks (see CORE-009 for the
concrete Docker container leak).

## Why it matters
Reliance on a manually-invoked teardown method is fragile in a long-lived
process: any path that drops the state without the ceremony leaks threads, PTYs,
child processes, or containers. Over a long session these accumulate.

## Evidence
`core/src/backends/local_shell.rs`, `core/src/backends/docker/mod.rs` — connected
state holds handles but has no `Drop` impl; cleanup lives only in `disconnect`.

## Recommendation
Implement `Drop` on the connected-state types to best-effort release resources
(kill/close/stop), so teardown is guaranteed even on panic or early return, with
`disconnect` remaining the graceful path.
