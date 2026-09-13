---
id: PER-006
title: Agent state.json — no lock, no version field, corrupt read silently discards all sessions
angle: persistence-migration
severity: high
category: reliability
is_workaround: false
subsystem: agent/src/state
evidence:
  - agent/src/state/persistence.rs:80
  - agent/src/state/persistence.rs:93
  - agent/src/state/persistence.rs:13
  - agent/src/state/persistence.rs:104
status: fixed
resolution: "#2778"
---

## What

The remote agent's `state.json` (the record of running sessions + their daemon sockets used for
recovery after an agent restart) has three persistence weaknesses:

1. **No version field.** `AgentState` (`persistence.rs:13-22`) has `sessions` and `update` but no
   schema version at all — the one store where a *self-updating* agent (the agent has an optional
   GitHub self-update) most needs migration is the one with the least versioning. Compatibility rests
   entirely on `#[serde(default)]` (the `legacy_state_without_*` tests confirm this is the whole
   strategy).
2. **Corrupt read → empty state (silent total discard).** `load_from` (`persistence.rs:80-101`)
   returns `Self::default()` on **either** a read error **or** a parse error, logging a `warn!` and
   moving on. A single malformed byte discards the entire session-recovery map — every persistent
   session the agent could have re-adopted is dropped.
3. **No cross-process lock.** ADR-11 runs multiple agent roles/workers (client transport, session
   daemon, registry daemon) against one host. `save_to` (`persistence.rs:104-127`) is atomic per
   write (good, #2366) but nothing coordinates *between* workers — two workers that both loaded the
   map and then save race last-writer-wins, dropping sessions the other added.

## Why it matters

`state.json` is the backbone of the agent-reconnect story that the release treats as
safety-critical. A corrupt read at agent startup means **all recoverable persistent sessions are
silently abandoned** — the user reconnects and their long-running sessions are simply gone, with only
a log line. The missing lock means that even without corruption, concurrent workers can lose
sessions from the map. And the absent version field means a self-updated agent has no migration hook
if the state shape ever changes non-additively (PER-001 in the one component that auto-updates
independently of the desktop).

## Evidence

- `persistence.rs:80-101` — `load_from`: `Err(_) => Self::default()` on read error and
  `Err(e) => { warn!(...); Self::default() }` on parse error. Both silently discard all sessions.
- `persistence.rs:13-22` — `AgentState` has no `version` field; only `#[serde(default)]` guards
  additive change.
- `persistence.rs:104-127` — atomic write, but no advisory lock; multiple ADR-11 workers share the
  path.

## Recommendation

- Add a `version` field and a migration hook, consistent with the desktop stores (PER-001).
- Distinguish "file missing" (fine → empty) from "file present but unparseable" (a real problem):
  back the corrupt file up to `.bak` and surface a warning to the desktop, rather than silently
  returning empty — losing every recoverable session should never be a silent `warn!`.
- Serialize writes across agent workers with an advisory lock around the load-modify-write, or route
  all state mutations through the single owning role (the daemon), so concurrent workers cannot drop
  each other's sessions.
</content>
