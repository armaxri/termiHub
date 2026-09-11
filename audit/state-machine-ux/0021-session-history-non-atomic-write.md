---
id: SM-021
title: Session-history is saved with a non-atomic write (torn-write resets history)
angle: state-machine-ux
severity: medium
category: reliability
is_workaround: false
subsystem: src-tauri/src/session_history/storage.rs
evidence:
  - src-tauri/src/session_history/storage.rs:90
  - src-tauri/src/workspace/storage.rs:89
  - src-tauri/src/workspace/last_session.rs:96
status: fixed
resolution: "#2318/#2366 — already on develop: session-history writes via write_atomic (audit branch stale)"
---

## What
`session_history/storage.rs:90` writes with plain `fs::write` (in-place O_TRUNC), while
workspaces (`workspace/storage.rs:89`) and last-session (`last_session.rs:96`) use the atomic
temp+fsync+rename helper `crate::utils::fs::write_atomic`. Session history is the one store
still exposed to torn writes.

## Why it matters
If the app is killed or crashes mid-write of `session-history.json`, the file is truncated to
invalid JSON. On next launch `load_with_recovery` `.bak`s it and **resets session history to
empty** — the exact torn-write data-loss class that #2318/#2320 fixed everywhere else, still
open on this one path.

## Evidence
- `session_history/storage.rs:90` — `fs::write` (non-atomic).
- `workspace/storage.rs:89`, `last_session.rs:96` — atomic writes (the fixed pattern).

## Recommendation
Route the session-history save through `crate::utils::fs::write_atomic`, matching the other
two stores.
