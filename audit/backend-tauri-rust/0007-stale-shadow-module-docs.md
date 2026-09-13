---
id: TAURI-007
title: Stale/misleading "shadow — not driving the live UI" module docs contradict migration status
angle: backend-tauri-rust
severity: medium
category: docs
is_workaround: false
subsystem: projection / *_projection / lib.rs
evidence:
  - src-tauri/src/lib.rs:870
  - src-tauri/src/lib.rs:904
  - src-tauri/src/connections_projection/projection.rs:44
  - src-tauri/src/agents_projection/mod.rs
status: open
---

## What

The doc comments that describe *which store is authoritative* — the single most important fact
a maintainer needs when touching this code — appear to be stale. `lib.rs` and every shadow
`*_projection` module state, in load-bearing detail, that the region is "not yet driving the
live UI", "a pure shadow foundation", and that "the `appStore` … remains authoritative". Yet
the project's own operating memory records the stateless-UI inversion as **done** (2026-08-26:
"all 11 domains reducer/flag-free, backend/region authoritative, reconnect engine deleted").

Both cannot be current. Either the code comments are stale (the migration finished and nobody
updated the ~9 "shadow" headers), or the migration is not actually done (memory is optimistic).

## Why it matters

These comments are exactly the kind that mislead the next engineer into a wrong mental model of
where truth lives. A maintainer who trusts "appStore remains authoritative" will debug a
divergence on the wrong side; one who trusts memory will delete a reducer that is still load
-bearing. In a codebase whose whole strategy is documented-in-comments (the `lib.rs` setup is
essentially a design doc), authoritative-source comments that are wrong about authority are a
real defect, not a nitpick.

## Evidence

- `lib.rs:870-930` — repeated "nothing in the live UI subscribes to or renders the region yet"
  headers across nine domains.
- `connections_projection/projection.rs:44-51` — "# Shadow mode … The `appStore` connections
  slice remains authoritative."
- Project memory (`phase5-projections-are-mirrors-not-authoritative.md`,
  `reconnect-grade-automated.md`) — inversion "DONE 2026-08-26", reconnect engine deleted.

## Recommendation

Reconcile the two. Once TAURI-006 is resolved one way or the other, do a single sweep updating
every `*_projection` module header and the `lib.rs` setup comments to state the *current*
authority and render/mutation-cut status per domain. If a per-domain status table exists in
docs, link it from the module headers rather than restating (and re-staling) it in nine places.
</content>
