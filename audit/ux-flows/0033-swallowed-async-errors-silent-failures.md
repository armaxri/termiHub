---
id: UX-033
title: ~45 async actions swallow errors, so operations can fail with no feedback
angle: ux-flows
severity: high
category: ux
is_workaround: true
subsystem: src (cross-cutting)
evidence:
  - src/components/OpenConnections/OpenConnectionsModal.tsx:362
  - src/components/EmbeddedServerSidebar/EmbeddedServerItem.tsx:124
  - src/components/Terminal/Terminal.tsx:1051
status: in-progress
resolution: "#2732 — critical action paths fixed; remainder #2733"
---

## What
Across the frontend there are ~45 sites that swallow a rejected promise with `.catch(() => {})`
(and similar), so the action fails with no toast, no log, and no state change the user can see.
Concentrations include the Open Connections panel (the app's primary place to inspect and *kill*
connections) — e.g. `OpenConnectionsModal.tsx:295,300,330,331,362,372,439,449,454,463,498` — plus
embedded-server open/start/stop (`EmbeddedServerItem.tsx:124,259,267`), terminal detach
(`Terminal.tsx:1051`), and others. Corroborates workaround-frontend WA-FE-005; framed here as the
user-facing consequence.

## Why it matters
This directly violates the project's own "every action gives feedback" rule. A user who clicks
"Kill" / "Disconnect" / "Stop server" in the Open Connections panel and hits a backend error sees
**nothing** — the row may even be optimistically removed while the underlying session/server keeps
running, exactly the kind of leak that panel exists to fix. Silent failure on teardown/kill actions
is especially serious on the ventilator-grade bar: the user believes a connection is gone when it
is not. This is a broad, systemic feedback gap rather than one bug.

## Evidence
- `OpenConnectionsModal.tsx:295–498` — many kill/disconnect/cancel actions with `.catch(() => {})`.
- `EmbeddedServerItem.tsx:124,259,267` — open URL / start / stop swallow errors.
- `Terminal.tsx:1051,1505` — detach / cancel-connect swallow errors.
- Note: some of these are paired with an optimistic UI removal, so a failed teardown leaves the row
  gone but the resource alive.

## Recommendation
Audit each swallowed-catch site: where the action is user-invoked and can fail meaningfully, surface
a `toast.error` (and `frontendLog`) and reconcile the optimistic UI on failure. Reserve silent
catches for genuinely best-effort fire-and-forget paths, and document why at each remaining site.
Prioritize the Open Connections kill/disconnect actions, where a silent failure means a
believed-dead connection is still live.
