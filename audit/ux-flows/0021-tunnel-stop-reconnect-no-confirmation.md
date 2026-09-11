---
id: UX-021
title: Tunnel Stop and force-Reconnect on a live tunnel have no confirmation
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/TunnelSidebar
evidence:
  - src/components/TunnelSidebar/TunnelListItem.tsx:199
  - src/components/TunnelSidebar/TunnelListItem.tsx:182
  - src/components/TunnelSidebar/TunnelSidebar.tsx:96
status: fixed
resolution: "#2775"
---

## What
Stop (`TunnelListItem.tsx:199-217`) and force-Reconnect (`:182-198`) fire immediately on a single
click with no confirmation. Reconnect tears down a live, working tunnel and re-establishes it
(`tunnelSlice.ts:245-270`), dropping all its active forwarded connections. By contrast Delete *does*
confirm active teardown (`TunnelSidebar.tsx:96-102`). So the destructive lifecycle actions on an
active tunnel are guarded inconsistently — the reversible one (Delete) prompts, the connection-
dropping ones (Stop/Reconnect) don't.

## Why it matters
An accidental click on Stop or Reconnect for a busy tunnel drops every connection flowing through it
(e.g. a database session, an RDP hop) with only an after-the-fact toast. For a tunnel actively
carrying traffic this is real disruption with no guard.

## Evidence
- `TunnelListItem.tsx:199-217` (Stop), `:182-198` (Reconnect) — immediate, no confirm.
- `tunnelSlice.ts:245-270` — Reconnect tears down then re-establishes.
- `TunnelSidebar.tsx:96-102` — Delete confirms active teardown (the inconsistency).

## Recommendation
Confirm Stop/Reconnect when the tunnel is active and carrying connections (reuse the ConfirmDialog
pattern used for Delete), or gate only when connection count > 0. Idle tunnels can skip the prompt.
