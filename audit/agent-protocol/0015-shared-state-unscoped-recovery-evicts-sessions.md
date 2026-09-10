---
id: AGT-015
title: Shared per-user state.json + unscoped recovery — a second desktop silently evicts the first desktop's live persistent sessions
angle: agent-protocol
severity: high
category: bug
is_workaround: false
subsystem: agent/src/session/manager.rs, agent/src/state/persistence.rs
evidence:
  - agent/src/session/manager.rs:856
  - agent/src/state/persistence.rs:134
  - agent/src/daemon/process.rs:194
status: open
---

## What
`state.json` lives at a **per-user, not per-worker** path
(`agent/src/state/persistence.rs:134`, `AgentState::default_path()`), yet the whole ADR-11
design runs **multiple `--stdio` workers per host** (one per attached desktop). On startup a
worker's `recover_sessions` (`agent/src/session/manager.rs:856`) unconditionally reconnects
to *every* persisted daemon in the shared file — including sessions another live worker
already owns. The session daemon drops its previous writer on every `accept` (generation
bump, `agent/src/daemon/process.rs:194`), so when desktop B's new worker recovers desktop
A's session, `connect_for_recovery` **evicts A**. Symptom: attaching a second desktop
silently steals the first desktop's live persistent terminals. Nothing tags a
`PersistedSession` with its owning worker/client, and nothing scopes recovery to sessions
this worker created.

## Why it matters
This is a correctness break on the flagship "sessions survive and reconnect" feature exactly
in the multi-desktop scenario the registry daemon was built to support. For a safety-critical
release, a second operator opening the app yanking the first operator's live session out from
under them is a serious behavioral defect.

## Evidence
- `agent/src/session/manager.rs:856-932` — `recover_sessions` reconnects to all persisted
  daemons, unscoped.
- `agent/src/state/persistence.rs:134-161` — per-user shared state path; `PersistedSession`
  carries no owner tag.
- `agent/src/daemon/process.rs:194-233` — daemon evicts the previous writer on each accept.

## Recommendation
Tag each `PersistedSession` with the owning client/worker identity and scope recovery to
sessions this worker created (or that are not currently owned by another live worker). Have
recovery consult the host registry to skip sessions an attached peer still holds, or make the
daemon reject a recovery connect from a non-owner while a live writer is attached.
