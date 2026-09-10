---
id: DUP-016
title: Agent SSH collector re-rolls CpuDeltaTracker; monitoring interval default duplicated
angle: code-duplication
severity: low
category: arch
is_workaround: false
subsystem: agent/monitoring/collector.rs, agent/monitoring/mod.rs, src-tauri monitoring
evidence:
  - agent/src/monitoring/collector.rs:157
  - core/src/monitoring/mod.rs:44
  - agent/src/monitoring/mod.rs:40
  - src-tauri/src/system_monitor_projection/store.rs:41
status: open
---

## What

Two low-severity monitoring tidy-ups:

1. The agent SSH collector hand-rolls `prev_cpu: Option<CpuCounters>` + a match to call
   `cpu_percent_from_delta`, duplicating the `CpuDeltaTracker` state machine that already exists in
   `core::monitoring` and is used by the desktop SSH provider. (It also redundantly rebuilds a whole
   new `SystemStats` just to inject the computed `cpu_usage_percent` —
   `agent/src/monitoring/collector.rs:225-237`.)
2. The 2000 ms default monitoring interval is defined at least three times: agent
   `DEFAULT_INTERVAL_MS`, desktop `DEFAULT_MONITORING_INTERVAL_MS` (store), and desktop
   `DEFAULT_MONITORING_INTERVAL_MS` (remote_proxy) — the store's doc comment says it "mirrors the
   frontend" value too.

## Why it matters

Low. The CpuDeltaTracker duplication is a trivial second copy of a pattern with a core home; the
interval constant is a scattered default that can drift across the two crates and the TS mirror.

## Evidence

- `agent/src/monitoring/collector.rs:157,219-223` (hand-rolled prev-cpu), `:225-237` (SystemStats
  rebuild); `core/src/monitoring/mod.rs:44-66` (`CpuDeltaTracker`);
  `core/src/backends/ssh/monitoring.rs:361` (desktop uses it correctly).
- `agent/src/monitoring/mod.rs:40` (`DEFAULT_INTERVAL_MS = 2000`);
  `src-tauri/src/system_monitor_projection/store.rs:41`;
  `src-tauri/src/session/remote_proxy.rs:14`.

## Recommendation

Have `SshCollector` hold a `CpuDeltaTracker` and mutate `stats.cpu_usage_percent` in place. Put a
single `pub const DEFAULT_MONITORING_INTERVAL_MS` in `core::monitoring` consumed by both crates.
