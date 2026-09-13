---
id: TAURI-010
title: Copy-pasted per-domain projection boilerplate across 10 domains
angle: backend-tauri-rust
severity: low
category: arch
is_workaround: false
subsystem: *_projection
evidence:
  - src-tauri/src/connections_projection/projection.rs:222
  - src-tauri/src/connections_projection/projection.rs:236
  - src-tauri/src/agents_projection/projection.rs
  - src-tauri/src/transfers_projection/projection.rs
status: open
---

## What

Each of the ~10 `*_projection` domains follows the same five-file template
(`mod.rs`, `projection.rs`, `store.rs`, `projection_tests.rs`, `store_tests.rs`) with
near-identical scaffolding:

- a `publish_<domain>(projector, store) -> Vec<ProducedRegion>` wrapper,
- a `fold_<domain>_from_manager(app)` best-effort resolver,
- a `store_of(app) -> Result<Arc<Store>, (String, String)>` lazy-resolve-or-`unavailable`,
- and a set of payload extractors (`required_str`, `required_usize`, `optional_str`,
  `required_<T>`, `optional_typed`) that are duplicated essentially verbatim per domain.

`connections_projection/projection.rs:222-319` is representative; the same helpers reappear in
`agents_projection`, `transfers_projection`, `settings_projection`, `system_monitor_projection`,
`file_browser_projection`, `workflow_projection`, `layout`, `restore_cohort_projection`,
`broadcast_projection`.

## Why it matters

This is a maintenance and drift risk: a fix to the intent-payload extraction or the
`store_of`/`unavailable` convention must be made in ~10 places, and the per-domain copies can
silently diverge (e.g. one domain treats a missing field as default, another as an error). It
amplifies every other projection finding (a poison-recovery or authorization change has to be
repeated 10×). It is not a correctness bug today.

## Evidence

- `connections_projection/projection.rs:222-319` — `store_of`, `required_str`, `required_usize`,
  `optional_str`, `required_connection`, `required_folder`, `optional_typed`.
- The same helper set duplicated across the sibling `*_projection/projection.rs` files.

## Recommendation

Factor the shared scaffolding into the `projection` module: a generic
`intent_payload::{required_str, required_u64, optional_str, required_typed, optional_typed}`
helper set, a `store_of::<S>(app)` generic over the managed store type, and a
`publish(store) -> Vec<ProducedRegion>` blanket helper on `ProjectedStore`. Domains would then
contain only their store's transition methods and their intent-kind routing table. Coordinate
with the code-duplication expert who owns cross-file duplication detail.
</content>
