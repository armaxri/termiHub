---
id: PROD-022
title: System monitoring works only for SSH connections
angle: product-completeness
severity: high
category: missing-feature
is_workaround: false
subsystem: core/backends
evidence:
  - core/src/backends/ssh/mod.rs:719
  - core/src/backends/local_shell.rs:669
  - core/src/backends/docker/mod.rs:927
  - core/src/backends/wsl.rs:992
status: open
---

## What
Only the SSH backend reports `monitoring: true`. Local shell, Docker, WSL, telnet, serial,
FTP, VNC and RDP all return `None` from `monitoring()`, so CPU/mem/disk stats are unavailable
for every non-SSH connection — including the local machine, Docker containers, and WSL distros.

## Why it matters
The monitoring feature clearly exists (SSH). Users reasonably expect at least local-machine
and Docker/WSL monitoring; its restriction to SSH is a surprising, unadvertised limitation.
(Reported by both the parity and networking passes — highest-impact of the two.)

## Evidence
- SSH `Some(...)` at `core/src/backends/ssh/mod.rs:719-722`.
- `None` in local_shell.rs:669, docker/mod.rs:927, wsl.rs:992, telnet.rs:414, serial.rs:452, ftp/mod.rs:575, vnc/mod.rs:633, rdp_sidecar/mod.rs:584.

## Recommendation
Implement a monitoring provider for at least local shell (native sysinfo) and Docker (stats
API)/WSL. This reuses the existing monitoring projection/UI end-to-end.
