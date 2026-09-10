---
id: SM-017
title: Embedded servers are absent from the Open Connections panel (violates the "every live subsystem" contract)
angle: state-machine-ux
severity: medium
category: bug
is_workaround: false
subsystem: src/components/OpenConnectionsModal.tsx
evidence:
  - src/components/OpenConnectionsModal.tsx:1
status: open
---

## What
The Open Connections panel is the canonical "see and force-kill every live subsystem"
surface. It now includes agents, system monitoring, HTTP monitors, tunnels, sessions, and
transfers — but **not embedded servers** (grep of `OpenConnectionsModal.tsx` returns zero
`embedded` matches). Running HTTP/FTP/TFTP embedded servers cannot be inspected or force-
stopped from the panel.

## Why it matters
A user hunting a resource leak (a bound port, a live server) will not find embedded servers
in the one panel that is supposed to list everything. It is the single documented exception
to that contract now that HTTP monitors and monitoring were added — an inconsistency that
defeats the panel's purpose and can hide a leaked listener.

## Evidence
- `OpenConnectionsModal.tsx` — has sections for agents/monitors/tunnels/sessions/transfers,
  none for embedded servers.

## Recommendation
Add an "Embedded Servers" group listing each running server with per-row Stop and a Kill-All,
matching the other subsystem groups.
