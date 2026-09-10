---
id: UX-023
title: "Save & Start" reports "Started" optimistically before the tunnel actually connects
angle: ux-flows
severity: low
category: ux
is_workaround: false
subsystem: src/components/TunnelEditor
evidence:
  - src/components/TunnelEditor/TunnelEditor.tsx:173
  - src/store/slices/tunnelSlice.ts:210
status: open
---

## What
"Save & Start" fires `startTunnel(config.id)` fire-and-forget (`.catch` only) and then closes the
tab (`TunnelEditor.tsx:173-178`). `tunnelSlice.ts:210-215` shows `toast.success("Started X")` when
the backend **accepts the intent**, not when the tunnel actually connects. The real
connecting→connected/error transition arrives later as a status diff (`_awaitingFirstConnect`,
`tunnelSlice.ts:215`, with failure re-raised per #2169). So "Started" can appear a beat before an
actual handshake-failure toast.

## Why it matters
A user can see a green "Started" and then, moments later, a failure toast for the same tunnel — a
brief but confusing status-legibility ambiguity. The later failure is surfaced, so this is minor,
but the optimistic success can mislead.

## Evidence
- `TunnelEditor.tsx:173-178` — fire-and-forget start, tab closes.
- `tunnelSlice.ts:210-215` — success toast on intent-accept, not on connect.

## Recommendation
Word the intent-accept feedback as pending ("Starting X…") and only toast success on the actual
connected transition, matching how the connection overlay distinguishes connecting from connected.
