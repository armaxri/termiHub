---
id: AGT-016
title: Concurrent workers clobber the shared state.json (lost-update) — no cross-process file lock
angle: agent-protocol
severity: medium
category: bug
is_workaround: false
subsystem: agent/src/session/manager.rs, agent/src/fs.rs
evidence:
  - agent/src/session/manager.rs:349
  - agent/src/session/manager.rs:523
  - agent/src/fs.rs:23
status: open
---

## What
Each worker holds its own in-memory `Mutex<AgentState>` (`agent/src/session/manager.rs:349`)
and writes the **whole** struct on every mutation (`:523`, `:730`, …). `write_atomic`
(`agent/src/fs.rs:23`) prevents a *torn* file but provides no cross-process concurrency
control. Classic lost update across the shared per-user `state.json` (AGT-015): worker A
loads, worker B loads, A inserts+saves, B inserts+saves → A's session vanishes from the file
and will not be recovered after a restart. No file lock, no flock'd read-modify-write.

## Why it matters
Combined with AGT-015's shared file, two concurrently-running desktops can silently drop each
other's persisted session metadata, defeating the survive-restart guarantee. Data loss is
silent — the last writer wins and the loser's sessions are simply gone.

## Evidence
- `agent/src/session/manager.rs:349` — per-worker in-memory `Mutex<AgentState>`.
- `agent/src/session/manager.rs:523` — whole-struct save on mutation.
- `agent/src/fs.rs:23-40` — atomic temp+rename, but no inter-process lock.

## Recommendation
Serialize state writes across processes with an advisory file lock (flock/LockFile) around a
read-modify-write, or move to per-worker state files, or a single owning daemon (the registry
daemon) that mediates all state writes.
