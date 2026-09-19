---
id: PROD-027
title: Serial and Telnet terminals do not propagate window size (no resize)
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: core/backends/serial, core/backends/telnet
evidence:
  - core/src/backends/serial.rs:337
  - core/src/backends/telnet.rs:249
status: open
---

## What
Serial (`resize:false`) and Telnet (`resize:false`) do not propagate terminal window size
changes to the remote, so full-screen TUIs (vim, htop) may render at the wrong dimensions.

## Why it matters
Resizing the window and having the remote reflow is expected for interactive TUIs. Serial has
no window-size concept (inherent); telnet could negotiate NAWS.

## Evidence
- `core/src/backends/serial.rs:337`, `core/src/backends/telnet.rs:249` — `resize:false`.

## Recommendation
Implement NAWS for telnet to enable resize. Serial is an inherent limitation — document it.
