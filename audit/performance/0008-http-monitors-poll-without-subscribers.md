---
id: PERF-008
title: HTTP monitors poll continuously with no subscribers, auto-started for every saved monitor on launch
angle: performance
severity: medium
category: perf
is_workaround: false
subsystem: core/src/monitoring/http_monitor.rs, src-tauri/src/network
evidence:
  - core/src/monitoring/http_monitor.rs:568
  - src-tauri/src/network/mod.rs:233
  - core/src/monitoring/http_monitor.rs:550
status: fixed
resolution: "#2810 — http monitors load stopped-but-listed (no auto-start N loops) + subscriber-gated checks; BEHAVIOR: resume-on-demand after restart. #2811 deferral"
---

## What
Each configured HTTP monitor runs an independent poll loop that issues a real HTTP request
every `interval_ms` (floor 1s) for the monitor's whole lifetime, driven by its start/stop
lifecycle and **not** by whether anything is subscribed to its results. On app launch the
backend reloads every persisted monitor config and **auto-starts a poll loop for each**, so
saved monitors fire network requests continuously even with the NetworkTools panel closed
and no UI listening. "Pause" only skips the request body but keeps the loop and its sleep
running.

## Why it matters
This is steady-state CPU + network + wakeup cost that exists regardless of user attention:
every saved monitor is a recurring outbound request and a broadcast into a channel that may
have zero receivers. A user who has configured a dozen monitors pays a dozen background HTTP
requests per interval from the moment the app starts, forever, whether or not they ever open
the monitors view. On a laptop this defeats app-idle power savings.

## Evidence
- `core/src/monitoring/http_monitor.rs:514-568` — `run_monitor` loop: `check_once`, `events.emit(...)`, `tokio::time::sleep(interval_ms)`; the emit (line 563) broadcasts even with no receivers.
- `core/src/monitoring/http_monitor.rs:550` — pause skips the HTTP body but the loop keeps sleeping/looping.
- `src-tauri/src/network/mod.rs:233` and `src-tauri/src/network/http_monitor_storage.rs:6-7` — persisted configs are reloaded and a poll loop auto-started for each at launch.

## Recommendation
- Decide the intended product semantics: if HTTP monitors are meant to run in the background
  (alerting), that is legitimate but should be explicit and ideally user-visible/opt-in with
  a global "monitoring active" indicator, and the interval floor should discourage very
  tight polling.
- If they are only meaningful while observed, gate the poll loop on subscription (start on
  first subscriber, stop/suspend when the last unsubscribes), so a launched-but-unobserved
  monitor does no network work.
- At minimum, avoid emitting into a subscriberless channel and avoid waking paused monitors
  to do nothing.
</content>
</invoke>
