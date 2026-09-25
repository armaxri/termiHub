---
id: SM-022
title: Persisted state carries a version field that is never read; no schema migration exists
angle: state-machine-ux
severity: medium
category: reliability
is_workaround: false
subsystem: src-tauri workspace/last_session/session_history
evidence:
  - src-tauri/src/workspace/last_session.rs:25
  - src-tauri/src/workspace/config.rs:161
  - src-tauri/src/session_history/config.rs:45
status: fixed
resolution: "#2746 — already on develop: VersionedStore/load_versioned wired to all 3 stores; newer=refused not reset (audit branch stale)"
---

## What
All three persisted stores write `version: "1"` (`last_session.rs:25`, `workspace/config.rs:161`,
`session_history/config.rs:45`) but the field is **never read** and there is no migration code
anywhere in the tree. Forward-compatibility rests entirely on serde (`#[serde(default)]` on
additive fields; no `deny_unknown_fields`).

## Why it matters
Any future breaking shape change (renamed required field, changed `#[serde(tag)]` enum,
restructured layout) will fail to deserialize old files, which are then silently reset to
defaults — workspaces/history via `.bak` + RecoveryWarning, last-session via a silent
`Ok(None)`. The user loses saved workspaces / last session with no migration and (for
last-session) no warning. A `version` field that is written but never branched on is a
migration mechanism that looks present but does nothing.

## Evidence
- `last_session.rs:25`, `workspace/config.rs:161`, `session_history/config.rs:45` — version
  written, never read; no migration branch in the tree.

## Recommendation
Add a real migration hook that branches on `version` (upgrading old shapes in place) before
the first breaking change ships, or explicitly document the field as reserved and gate reads
on it now while the schema is still v1.
