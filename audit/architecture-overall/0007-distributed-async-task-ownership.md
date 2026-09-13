---
id: ARCH-007
title: No central async-task ownership — 84 spawn sites, ~3 handle registries, teardown scattered per subsystem
angle: architecture-overall
severity: medium
category: reliability
is_workaround: false
subsystem: src-tauri/src
evidence:
  - src-tauri/src/session_projection/timer.rs:106
  - src-tauri/src/lib.rs:235
  - src-tauri/src/session/graphical_manager.rs:146
status: open
---

## What

Long-running async work is spawned from ~84 sites in `src-tauri` alone
(`tokio::spawn` / `task::spawn` / `thread::spawn`), but task lifetime/ownership
is tracked inconsistently:

- A few subsystems keep explicit, cancellable handle registries — e.g.
  `session_projection/timer.rs:106` (`Mutex<HashMap<String, JoinHandle>>`, the
  cleanest example) and `session/graphical_manager.rs:146` (`Vec<JoinHandle>`).
- Most long-lived spawns are owned implicitly via a `CancellationToken` (the
  cancellation primitive *is* consistent — see below) plus `Drop`, without a
  stored handle: transfers, tunnels, monitoring controllers, agent managers.
- Others (`utils/download.rs`, `utils/remote_exec.rs`,
  `session/ssh_host_key_verifier.rs`, `spawn/ipc_server.rs`) spawn with no
  visible registry at all; lifetime rides the surrounding struct or a channel
  closing.

App-wide teardown is a hand-maintained list in `run_app_teardown`
(`lib.rs:235-266`) that reaches into each manager's `stop_all`/`cancel_all` by
`try_state`. There is no single task registry; each subsystem must remember to
register itself in that teardown function.

(Cancellation itself is coherent: `tokio_util::sync::CancellationToken` is used
uniformly — ~271 sites across core/src-tauri/agent — so this is an *ownership/
teardown* gap, not a cancellation-primitive gap.)

## Why it matters

- **Leak/orphan risk on the reliability hot path.** The app already has a
  runtime consolidation panel (Open Connections) specifically to *find* leaked
  connections — evidence that teardown is distributed enough to need a
  human-inspectable backstop. A subsystem that forgets to wire into
  `run_app_teardown` leaks its tasks/processes on exit with nothing catching it
  at compile time.
- **Correctness on a ventilator-grade app:** orphaned SSH/agent/transfer tasks
  that outlive their session can hold sockets, half-written files, or PTYs; the
  teardown ordering (transfers before sessions, `lib.rs:256-261`) is encoded
  only as comments in one function.

## Evidence

- `src-tauri/src/lib.rs:235-266` — `run_app_teardown` manually enumerates each
  manager; adding a subsystem requires editing this list.
- `src-tauri/src/session_projection/timer.rs:106` — the good pattern (keyed,
  cancellable handle map) exists but is not the norm.
- ~84 `spawn` sites vs ~3 explicit `JoinHandle` registries.

## Recommendation

Adopt one owned-task abstraction (e.g. a `tokio_util::task::TaskTracker` or a
small `TaskRegistry` held in managed state) that every subsystem's spawns route
through, so shutdown is `tracker.close(); tracker.wait()` in one place rather
than a hand-kept `stop_all` list. At minimum, make each manager's `Drop`
cancel/join its own tasks so correctness does not depend on remembering to edit
`run_app_teardown`.
