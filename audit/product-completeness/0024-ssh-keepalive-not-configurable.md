---
id: PROD-024
title: SSH keepalive interval is hard-coded, not user-configurable
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: core/backends/ssh
evidence:
  - core/src/backends/ssh/auth.rs:122
status: open
---

## What
Keepalive is hard-coded to 30s with 3 missed responses; there is no UI field to tune it.

## Why it matters
Restrictive firewalls/NAT idle timeouts and long-idle sessions often need a shorter (or
longer) keepalive. Power users expect `ServerAliveInterval`-style control.

## Evidence
- `core/src/backends/ssh/auth.rs:122-125` — `keepalive_interval: Some(Duration::from_secs(30))`, 3 misses.

## Recommendation
Expose keepalive interval and max-misses as optional advanced SSH settings with the current
values as defaults.
