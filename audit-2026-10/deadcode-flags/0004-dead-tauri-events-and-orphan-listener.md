---
id: DEAD2-004
title: "Pre-projection Tauri events are still emitted with no listener, and the remote-state-change listener has no emitter"
angle: deadcode-flags
severity: low
category: dead-code
is_workaround: false
subsystem: "src-tauri/tunnel, src-tauri/terminal/agent_deploy, src/components/Terminal"
evidence:
  - src-tauri/src/tunnel/tunnel_manager.rs:1774
  - src-tauri/src/tunnel/tunnel_manager.rs:1143
  - src-tauri/src/tunnel/tunnel_manager.rs:260
  - src-tauri/src/tunnel/tunnel_manager.rs:264
  - src-tauri/src/terminal/agent_deploy.rs:798
  - src/components/Terminal/TerminalView.tsx:85
  - src/components/Terminal/TerminalView.tsx:99
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

I diffed backend emits against frontend listens. (1) `tunnel-status-changed` (tunnel_manager.rs:1774, which the code calls the 'legacy event ... (strangler)') and `tunnel-stats-updated` (emitted for every active tunnel every second, :1143) have no frontend listener. SM-009 (d9b0f57cd) removed the onTunnel\* wrappers, and the tunnels projection region now carries both. The doc comment at :264 still says the frontend listener `onTunnelStatsUpdated` reads the payload; that function no longer exists. (2) `agent-deploy-progress` (agent_deploy.rs:798) has no listener; DEAD-007's fix removed it, and its only producer, deploy_agent, is itself dead (see the IPC finding). (3) The reverse case: TerminalView.tsx:99 registers a `remote-state-change` listener that no backend code emits. The comment above it admits the backend never emits it and keeps it as a 'forward-compatible hook'.

## Why it matters

These are leftovers of the projection migration. The tunnel stats event broadcasts IPC to every webview once a second per tunnel for nothing, and the stale doc comments point readers at removed code. The orphaned listener is a dead disconnect path that still looks wired, which misleads anyone debugging disconnect handling.

## Evidence

- `src-tauri/src/tunnel/tunnel_manager.rs:1774`
- `src-tauri/src/tunnel/tunnel_manager.rs:1143`
- `src-tauri/src/tunnel/tunnel_manager.rs:260`
- `src-tauri/src/tunnel/tunnel_manager.rs:264`
- `src-tauri/src/terminal/agent_deploy.rs:798`
- `src/components/Terminal/TerminalView.tsx:85`
- `src/components/Terminal/TerminalView.tsx:99`

## Recommendation

Delete the `tunnel-status-changed` and `tunnel-stats-updated` emits, plus TUNNEL_STATS_EVENT and TunnelStatsUpdate if nothing else uses them, and keep publish_tunnels as the only channel. Remove emit_progress / `agent-deploy-progress`, or remove it along with deploy_agent. Remove the remote-state-change useEffect in TerminalView.tsx, and fix the tunnel_manager.rs:264 doc.

## Verification

Confirmed. tunnel_manager.rs emits 'tunnel-stats-updated' (:1143, per tunnel every second) and 'tunnel-status-changed' (:1774), and agent_deploy.rs:800 emits 'agent-deploy-progress'. None of the three has a listener in src/. TerminalView.tsx:99 listens for 'remote-state-change', and its own comment admits no backend emits it; I found no emitter in src-tauri, core or agent. DEAD-007 removed the events.ts copies but left these leftovers.
