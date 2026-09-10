---
id: PERF-006
title: Every projection publish re-serializes the entire region, giving O(N²) work as entries grow
angle: performance
severity: medium
category: perf
is_workaround: false
subsystem: src-tauri/src/system_monitor_projection, src-tauri/src/projection
evidence:
  - src-tauri/src/system_monitor_projection/store.rs:125
  - src-tauri/src/projection/mod.rs:246
status: open
---

## What
The projection wire protocol is efficient (minimal RFC-6902 diffs; a no-op publish sends
nothing). But producing each diff is not: on **every** state change the store's
`snapshot()` re-serializes the **whole region** with `serde_json::to_value` over all
entries, and `publish` diffs that freshly-built full tree against the previous full tree.
For per-session monitoring this runs on every stats sample. With N monitored sessions each
sampling every 2s, each sample re-serializes and diffs the entire N-entry region → roughly
O(N²) serialize+diff work per 2s window, even though only one entry changed and only a tiny
diff reaches the webview.

## Why it matters
It is invisible at a handful of monitors but grows quadratically with the number of active
monitored sessions/connections. The same "snapshot-the-whole-store-then-diff" pattern is
used by the sessions, connections and transfers projections, so a fleet with many open
sessions or several concurrent transfers pays repeated whole-region serialization on the
backend async runtime. This is CPU the app spends to compute a diff it could compute
incrementally.

## Evidence
- `src-tauri/src/system_monitor_projection/store.rs:125-140` — `snapshot()` loops over **all**
  `monitors` and **all** `stats_cache` entries calling `serde_json::to_value(entry)` /
  `to_value(stats)` on each, building the whole tree.
- `src-tauri/src/projection/mod.rs:246-262` — `publish` does `compute_ops(&state.view, &new_view)` (`json_patch::diff` of the two whole trees), returns `None`/no frame if empty.
- Same pattern: `src-tauri/src/session_projection/projection.rs:70`,
  `connections_projection/projection.rs`, `transfers_projection/projection.rs:78-79`.

## Recommendation
- Maintain the serialized region view incrementally: keep the last `serde_json::Value` and
  update only the changed entry's subtree on a fold, then diff (or emit) just that path,
  instead of rebuilding and diffing the entire tree each time.
- Alternatively, have folds emit the specific ops they imply (they already know which entry
  changed) rather than round-tripping through a whole-store snapshot + structural diff.
- Bounds the per-sample cost to O(change) and removes the quadratic growth with entry count.
</content>
</invoke>
