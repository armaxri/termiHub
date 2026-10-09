---
id: DEAD2-002
title: "The graphical SessionStateMachine's reconnect budget and ServerClosed state are dead, so the 'Session closed by server' UI can never appear"
angle: deadcode-flags
severity: medium
category: dead-code
is_workaround: true
subsystem: "core/connection/graphical + src-tauri/session/graphical_supervisor"
evidence:
  - core/src/connection/graphical.rs:838
  - core/src/connection/graphical.rs:855
  - core/src/connection/graphical.rs:867
  - core/src/connection/graphical.rs:815
  - src-tauri/src/session/graphical_supervisor.rs:226
  - src-tauri/src/session/graphical_supervisor.rs:356
  - src-tauri/src/session/graphical_supervisor.rs:360
  - src-tauri/src/session/graphical_supervisor.rs:383
  - src/components/RemoteDesktop/RemoteDesktopOverlay.tsx:77
  - src/components/RemoteDesktop/RemoteDesktopOverlay.tsx:93
  - core/src/connection/lifecycle.rs:148
status: fixed
resolution: "#4321 — reconnect engine is the sole budget (enter_reconnecting); RDP deliberate ERRINFO ends reach ServerClosed with no retry"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Since #3364 the graphical supervisor runs auto-reconnect on the canonical reconnect_reducer engine. It still keeps the older SessionStateMachine, which has its own attempt counter and cap (begin_reconnect / can_reconnect / max_reconnects). To move it into Reconnecting, the supervisor calls three transitions in a row: connection_dropped(); reconnect_attempt_failed(); begin_reconnect() (graphical_supervisor.rs:360-362). rest() does the same with drop+fail (383-384). can_reconnect(), server_closed() and manual_reconnect() have no callers outside graphical.rs's own unit tests. Since server_closed() is never called, GraphicalState::ServerClosed is never produced, yet the frontend overlay renders a 'Session closed by server' branch (RemoteDesktopOverlay.tsx:77,93) and lifecycle.rs:148 maps it. When a stream ends cleanly with no fatal_error, the supervisor treats it as an ordinary Drop and starts auto-reconnect (graphical_supervisor.rs:226-232).

## Why it matters

Two counters track the same reconnect budget, and one of them is only kept in step by a shim of three calls in a row. That invites drift if someone changes one policy and not the other. The dead ServerClosed state also hides a likely behavior gap. A deliberate server-side end (an RDP user logging off, a VNC server shutting down) cannot be told apart from a network drop, so termiHub re-dials and may re-log the user in instead of showing 'Session closed by server'.

## Evidence

- `core/src/connection/graphical.rs:838`
- `core/src/connection/graphical.rs:855`
- `core/src/connection/graphical.rs:867`
- `core/src/connection/graphical.rs:815`
- `src-tauri/src/session/graphical_supervisor.rs:226`
- `src-tauri/src/session/graphical_supervisor.rs:356`
- `src-tauri/src/session/graphical_supervisor.rs:360`
- `src-tauri/src/session/graphical_supervisor.rs:383`
- `src/components/RemoteDesktop/RemoteDesktopOverlay.tsx:77`
- `src/components/RemoteDesktop/RemoteDesktopOverlay.tsx:93`
- `core/src/connection/lifecycle.rs:148`

## Recommendation

Make reconnect_reducer the only reconnect authority. Remove reconnect_attempts / max_reconnects / can_reconnect / begin_reconnect's cap from SessionStateMachine, and add one direct `enter_reconnecting(attempt)` transition to replace the three-call shim. Then either make ServerClosed reachable by having backends report a clean server close (e.g. a typed fatal_error such as SessionError::ServerClosed that fatal_rest maps to rest(ServerClosed)), or delete the variant, server_closed(), manual_reconnect() and the overlay branch.

## Verification

Confirmed, and worse than reported. can_reconnect, server_closed and manual_reconnect are only called from graphical.rs tests. The supervisor's begin_attempt uses the three-call shim (drop, fail, begin_reconnect). The RDP sidecar does send SidecarMessage::State(ServerClosed) on a clean server end (rdp-sidecar/src/rdp.rs:638), but core/src/backends/rdp_sidecar/mod.rs:557 only logs State messages at debug level and drops them. A clean logoff therefore turns into an ordinary Drop and auto-reconnects, and the overlay's 'serverClosed' branch can never show. I found no ADR or audit note saying this is deliberate.
