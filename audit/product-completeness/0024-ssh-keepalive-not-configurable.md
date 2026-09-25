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
status: fixed
resolution: "#3121 — configurable SSH keepalive: SshConfig gains optional keepaliveIntervalSecs/keepaliveMaxCount (camelCase, skip_if_none) + accessors falling back to DEFAULT 30/3 when absent (no behavior change, byte-stable saved connections). auth.rs uses config.keepalive_interval()/max_count(). Schema-driven advanced fields (Number, placeholders 30/3) via DynamicForm. SshConfig not ts-rs-exported → no generated types. 1751 core tests"
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
