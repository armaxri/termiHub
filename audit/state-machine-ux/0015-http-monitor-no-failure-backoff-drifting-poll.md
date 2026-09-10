---
id: SM-015
title: HTTP monitor has no failure backoff and a drifting poll period
angle: state-machine-ux
severity: low
category: reliability
is_workaround: false
subsystem: core/src/monitoring/http_monitor.rs
evidence:
  - core/src/monitoring/http_monitor.rs:542
status: open
---

## What
The HTTP monitor poll loop is still `check → emit → sleep(interval_ms)` using a post-work
`tokio::time::sleep` (`http_monitor.rs:542-572`) rather than a fixed-rate
`tokio::time::interval`, and applies no backoff on repeated failures. (The min-interval floor
`MIN_INTERVAL_MS=1000` at `:55-62` was fixed; this is the surviving half of the old spec #8.)

## Why it matters
- **No backoff:** a down endpoint is hammered every interval indefinitely (e.g. 12 doomed
  requests/min at a 5s interval).
- **Drifting period:** the effective poll period is `interval + latency` (up to `+timeout`
  when the host hangs), so the `Up/Down` chart x-axis — which assumes a fixed interval —
  silently skews the further behind the poll drifts.

## Evidence
- `http_monitor.rs:542-572` — post-work sleep, no backoff, no fixed-rate scheduling.

## Recommendation
Use `tokio::time::interval` (fixed-rate, `MissedTickBehavior::Delay`) so the schedule does
not drift, and apply exponential backoff on consecutive failures to stop hammering a dead
host.
