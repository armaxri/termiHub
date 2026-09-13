---
id: PER-005
title: No cross-process file locking; concurrent instances clobber every JSON store (last-writer-wins)
angle: persistence-migration
severity: high
category: reliability
is_workaround: false
subsystem: src-tauri/src (all storage.rs), src-tauri/src/utils/config_paths
evidence:
  - src-tauri/src/utils/fs.rs:23
  - src-tauri/src/connection/storage.rs:168
  - src-tauri/src/workspace/storage.rs:86
  - src-tauri/src/connection/manager.rs:187
status: open
---

## What

None of the JSON config stores take an OS-level file lock (advisory `flock`, `fd-lock`, a lockfile,
or a single-instance guard). A repository-wide search for `flock`/`fs2`/`fd_lock`/lockfile/
single-instance turns up **nothing** for the config layer. `write_atomic` makes each individual
write *atomic* (no torn file) but does nothing about **two writers racing** — the temp-rename simply
means the last rename wins, silently discarding the other writer's changes wholesale.

Within a single process this is fine: the managers hold an in-memory `Mutex` and serialize
saves. But termiHub can have **more than one process** touching the same config directory:

- A second launch of the desktop app (nothing prevents it — no single-instance guard was found in
  the config path; the only "another instance" logic is IPC-endpoint ownership in `lib.rs:1251`, not
  a config lock).
- **Portable mode** (`data/` beside the exe) running alongside an installed copy that resolves the
  same profile dir, or two portable copies pointed at one folder.
- The desktop and any tooling/tests sharing `TERMIHUB_CONFIG_DIR`.

Each instance does load-into-memory at startup, then writes the *whole* store on every mutation.
Two instances started from the same config dir each hold a stale full copy; whichever saves last
overwrites the other's connections / workspaces / last-session / settings entirely.

## Why it matters

Cross-instance data loss with no warning: create a connection in window A, and a save triggered by
window B (which loaded before A's change) reverts it on disk. The connection manager has a partial
mitigation — several methods `sync_from_disk` / reload before mutating (`manager.rs:187`, `215`,
`238`) precisely to "not resurrect connections deleted by another instance" — but this is a
best-effort read-modify-write with a TOCTOU window, applies only to connections, and is absent from
workspaces, last-session, session-history, workflows, and settings. It is not a substitute for a
lock.

## Evidence

- `utils/fs.rs:23` — `write_atomic` guarantees single-write atomicity only; no locking.
- `connection/storage.rs:168`, `workspace/storage.rs:86`, etc. — each `save*` serializes and writes
  the whole store; no coordination between processes.
- `connection/manager.rs:187-257` — reload-before-mutate mitigation, connections-only, TOCTOU-prone;
  the test assertions ("must not resurrect connections deleted by another instance") show the hazard
  was recognized but only partially addressed.

## Recommendation

- Add a **single-instance guard** for the desktop app (Tauri has a `single-instance` plugin) keyed
  on the resolved config dir, so a second launch focuses the existing window instead of racing it —
  this removes the common case entirely.
- For the cases that legitimately share a dir (portable + installed), take an **advisory lock**
  (e.g. `fd-lock`/`fs2`) around the load-modify-write of each store, or centralize all writes behind
  a single owning process.
- At minimum, make every store follow the connections pattern: reload-from-disk under the lock
  immediately before writing, and merge rather than overwrite, to shrink the clobber window.
</content>
