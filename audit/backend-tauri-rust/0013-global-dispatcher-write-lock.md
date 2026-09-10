---
id: TAURI-013
title: Single global dispatcher write_lock serialises every intent across all domains
angle: backend-tauri-rust
severity: info
category: perf
is_workaround: false
subsystem: projection
evidence:
  - src-tauri/src/projection/mod.rs:344
  - src-tauri/src/projection/mod.rs:360
status: open
---

## What

`Dispatcher` holds one process-wide `write_lock: Mutex<()>` and takes it for the whole
read-decide-mutate-publish step of **every** intent, regardless of domain
(`projection/mod.rs:344-366`). So a `layout.moveTab` intent, a `connection.add`, and a
`settings.update` all serialise against each other on a single mutex even though they touch
disjoint regions and disjoint stores.

## Why it matters

Correctness-wise this is safe (it is the substrate's deliberate single-writer guarantee, and
each handler is a fast in-memory edit). It is only a scalability note: as more domains cut over
and as remote-client mode multiplies intent traffic, a global lock across unrelated domains is
an unnecessary contention point, and any slow handler (e.g. one that does I/O — the connections
fold rebuilds the whole unified view from disk) blocks intents for every other domain while it
runs. The `fold_*` path notably does disk I/O and, although it runs outside this lock today,
the design intends handlers to be the single writer.

## Evidence

- `projection/mod.rs:344-366` — `write_lock: Mutex<()>`; `dispatch` locks it for the full
  `handler.handle(...)` call.

## Recommendation

No action required for the desktop release. If/when intent volume grows, consider per-region
(or per-domain) write locks so unrelated domains dispatch concurrently, keeping the single
-writer guarantee *per region* rather than globally. Ensure intent handlers stay pure/fast (no
blocking I/O under the write lock) so one domain cannot stall the rest.
</content>
