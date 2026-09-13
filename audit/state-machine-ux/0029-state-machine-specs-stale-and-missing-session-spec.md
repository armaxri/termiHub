---
id: SM-029
title: The docs/audits state-machine specs are stale historical snapshots; the most user-visible machine has no spec
angle: state-machine-ux
severity: info
category: docs
is_workaround: false
subsystem: docs/audits/*state-machine*.md
evidence:
  - docs/audits/remote-agent-lifecycle-state-machine.md:1
  - docs/audits/workspace-save-restore-state-machine.md:1
  - docs/audits/http-monitor-state-machine.md:1
status: open
---

## What
The eight `docs/audits/*state-machine*.md` documents (dated 2026-07-09, tied to issues
#1131/#1135/#1136/#1141/#1229 etc.) are **historical audit snapshots of a pre-refactor
codebase**, not current maps. Verified against today's code, the large majority of their
documented gaps are already **fixed or made moot by architectural removal**:
- Agent lifecycle G1–G10, HTTP #1–#11, monitoring G1–G10, embedded G1–G9, credential G1–G8,
  tunnel GAP1–9, SFTP L/S/D items, workspace G1–G7 — nearly all closed.
- Several spec "facts" are now **inverted**: e.g. tunnel `get_statuses` DOES return
  `Error`/`Reconnecting` now; HTTP `running:false` went from "unreachable dead code" to the
  intended stopped state; SFTP now has a full first-class transfer-queue machine; monitoring
  `Paused` is implemented.
- All line numbers in the specs are wrong (post-refactor drift).

Separately, there is **no reference state-machine doc for the connection/session lifecycle**
itself — the single most user-visible machine (connecting → connected → reconnecting →
disconnected/failed/sessionLost), which is where the highest-severity live defects were found
(SM-001..SM-006).

## Why it matters
The specs will mislead anyone using them to triage: actioning their gap lists would re-open
already-closed work and reason from false facts. And the machine that most needs a written
contract (session lifecycle, with its overloaded `Reconnecting`, timer-vs-agent regimes, and
multi-desktop invariant) has none — which is why its invariants (SM-003) drifted from the code
and its stuck states (SM-001) went uncaught.

## Evidence
- Cross-checked each spec's gap list against current code (see SM-002..SM-028 for the residual
  live items and the many closed ones).

## Recommendation
Regenerate the eight specs from current code (or mark them clearly as historical), and author
a new reference state-machine doc for the connection/session lifecycle region
(`src-tauri/src/session_projection/`) as the authoritative contract — including the
`Reconnecting(Waiting)` vs `Reconnecting(Idle)` regimes, the terminal states, cancellation
guarantees, and the intended multi-desktop shared-status invariant.
