---
id: PROD-025
title: Telnet editor exposes only host + port (no auto-login, terminal-type, line-mode)
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: core/backends/telnet
evidence:
  - core/src/backends/telnet.rs:207
status: open
---

## What
The telnet connection editor offers only host and port. There are no saved credentials /
auto-login, terminal-type negotiation, or line-mode options; telnet is also non-persistent
and non-resizable.

## Why it matters
Telnet users (network gear, legacy devices) often want saved auto-login and a terminal-type;
the bare editor makes repeated logins manual.

## Evidence
- `core/src/backends/telnet.rs:207-231` — schema is host+port only; `persistent:false`, `resize:false`.

## Recommendation
Add optional auto-login (username/password sent on prompt match) and terminal-type; consider
window-size negotiation (NAWS) for resize.
