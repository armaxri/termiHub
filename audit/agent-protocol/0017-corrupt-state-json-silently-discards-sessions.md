---
id: AGT-017
title: A corrupt or partial state.json silently discards ALL recoverable sessions
angle: agent-protocol
severity: medium
category: reliability
is_workaround: false
subsystem: agent/src/state/persistence.rs
evidence:
  - agent/src/state/persistence.rs:80
status: open
---

## What
`AgentState::load_from` (`agent/src/state/persistence.rs:80`) returns `Self::default()` —
zero sessions — on any parse error, logging only a `warn!`. Combined with the cross-process
clobber risk (AGT-016, which can produce partial/interleaved content), one bad read silently
abandons every recoverable persistent session: no backup, no `.corrupt` quarantine, no
signal to the desktop.

## Why it matters
The advertised guarantee is "persistent sessions survive agent restarts." Silent total loss
on a single corrupt read is a quiet failure of that guarantee — the operator sees their
sessions simply gone with no error, and the underlying daemons may still be running but
unreferenced (compounding AGT-019's orphan leak).

## Evidence
- `agent/src/state/persistence.rs:80-101` — `load_from` → `default()` (empty) on parse error,
  `warn!` only.

## Recommendation
On parse failure, quarantine the bad file (rename to `state.json.corrupt-<ts>`) rather than
discarding it, keep a rolling backup of the last-good state, attempt recovery from the
backup, and surface a diagnostic the desktop can show. Never silently drop all session state.
