---
id: PROD-019
title: RDP audio redirection is a no-op on Linux despite the config toggle
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: true
subsystem: core/backends/rdp_sidecar
evidence:
  - core/src/backends/rdp_sidecar/config.rs:100
  - core/src/backends/rdp_sidecar/config.rs:428
status: open
---

## What
The "Redirect Audio Output" toggle exists for RDP but does nothing on Linux (support is
"planned"). The setting is shown and silently ineffective on that platform.

## Why it matters
A visible setting that silently does nothing on a supported OS misleads Linux users. Either
implement or hide/annotate it per platform.

## Evidence
- `core/src/backends/rdp_sidecar/config.rs:100-105, 428-430` — Linux audio "planned".

## Recommendation
Implement rdpsnd output on Linux (PulseAudio/PipeWire) or gate the toggle off with a
"not available on Linux" note. Marked workaround because the control ships inert.
