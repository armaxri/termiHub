---
id: DUP-014
title: The connection-type-id field is serialized under three different names
angle: code-duplication
severity: low
category: reliability
is_workaround: false
subsystem: src-tauri/session, agent/session, agent/state
evidence:
  - src-tauri/src/session/manager.rs:232
  - agent/src/session/types.rs:84
  - agent/src/session/definitions.rs:14
  - agent/src/state/persistence.rs:8
status: open
---

## What

The same concept — "which connection type is this" — is spelled three different ways across
serialized boundaries: `connection_type` (desktop `SessionInfo`), `type_id` (agent `SessionInfo`
and `PersistedSession`), and `session_type` (agent `Connection` definition).

## Why it matters

Low, but it is a bug trap on the desktop↔agent wire and in persisted state: any code that maps
between these models has to remember which spelling applies where, and a hand-built JSON payload
(DUP-001) can silently use the wrong key. It is a symptom of the parallel type hierarchies in
DUP-008.

## Evidence

- `src-tauri/src/session/manager.rs:232` — `connection_type`.
- `agent/src/session/types.rs:84` — `type_id`.
- `agent/src/state/persistence.rs:8` — `type_id` (`PersistedSession`).
- `agent/src/session/definitions.rs:14` — `session_type`.

## Recommendation

Standardize on one field name (`type_id` is the most common) in the shared connection/session
definitions from DUP-008/DUP-010, using serde rename only where an on-disk format must stay
backward-compatible. Removes the per-boundary translation.
