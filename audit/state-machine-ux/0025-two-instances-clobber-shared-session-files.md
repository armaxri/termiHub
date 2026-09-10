---
id: SM-025
title: Two app instances clobber the shared last-session/workspace files (cross-instance data loss)
angle: state-machine-ux
severity: high
category: reliability
is_workaround: false
subsystem: src-tauri persistence (LastSessionManager/WorkspaceManager) + single-instance
evidence:
  - src-tauri/Cargo.toml:1
  - src-tauri/src/lib.rs:1102
  - src-tauri/src/workspace/last_session.rs:96
status: open
---

## What
There is no single-instance plugin (absent from `src-tauri/Cargo.toml`), so two termiHub
instances ("two desktops") can run concurrently. `LastSessionManager`/`WorkspaceManager` are
per-process singletons (`lib.rs:1102/1170`) that write a **shared** `last-session.json` /
`workspaces.json` on disk guarded only by an **in-process** `Mutex` — no OS file lock, no
cross-process coordination. Both instances auto-save on every layout change (debounced 500ms).

## Why it matters
Interleaving: two instances each auto-saving → last-writer-wins. Instance A's last session
silently overwrites instance B's; on restart only the last writer's session survives — the
other's open tabs/layout are lost. The atomic write prevents a *torn* file but not the
*clobber*. The per-process ownership maps also do zero cross-instance session-eviction
coordination, compounding the multi-desktop session-eviction concern (see SM-003).

## Evidence
- `src-tauri/Cargo.toml` — no `tauri-plugin-single-instance`.
- `lib.rs:1102/1170` — per-process persistence singletons.
- `last_session.rs:96` — atomic write (prevents tearing, not clobber); shared path, no file
  lock.

## Recommendation
Decide the multi-instance contract with the maintainer: either enforce single-instance (a
single-instance lock that focuses the existing window), or scope the last-session file per
instance, or add an OS file lock + merge so concurrent instances cannot silently overwrite
each other's saved session.
