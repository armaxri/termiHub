---
id: AGT-027
title: Coordinated update is fail-open and "gone = acked" — a briefly-dropped peer is treated as having consented to be cut off
angle: agent-protocol
severity: low
category: reliability
is_workaround: false
subsystem: agent/src/update/coordinate.rs
evidence:
  - agent/src/update/coordinate.rs:164
  - agent/src/update/coordinate.rs:203
status: open
---

## What
The coordinated-update model ("the ack is the disconnect", `agent/src/update/coordinate.rs`)
resolves *every* failure to "proceed": no registry view, timeout, or empty peer set all
return proceed (`coordinate.rs:164-236`). This is deliberate and documented (availability over
strict coordination), but it has two consequences worth an explicit sign-off on a
safety-critical release:

1. **A peer cannot veto an update**, and a registry outage causes an un-notified hard cut of
   every other client.
2. **Reconnect-mid-window race:** because "gone means acked" (`coordinate.rs:203` seeds
   `last_seen` from the census), a client that briefly drops (a network blip) around the
   deadline is treated as having consented to be cut off, or is reported inconsistently. The
   100 ms poll bounds detection latency but does not remove the ambiguity.

The blinking-registry case (a mid-wait `None` not read as "all left") is handled correctly
and well-tested — this finding is only about the deliberate fail-open policy and the
gone=acked equivalence.

## Why it matters
For a ventilator-grade product, "any coordination failure proceeds with a hard cut" is a
policy choice that should be explicitly reviewed and accepted, not just inherited. A
momentary network blip counting as consent to interrupt could surprise an operator.

## Evidence
- `agent/src/update/coordinate.rs:164-236` — proceed on no-view/timeout/empty.
- `agent/src/update/coordinate.rs:203` — census seeds `last_seen`; gone = acked.

## Recommendation
Document and sign off the fail-open policy explicitly. Consider a short grace re-poll before
treating a just-departed peer as acked, so a network blip is not read as consent. Optionally
allow a peer to signal "busy, do not cut" for the courtesy window.
