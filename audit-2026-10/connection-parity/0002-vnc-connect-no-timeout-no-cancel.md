---
id: PARITY2-002
title: "VNC initial connect has no timeout and cannot be cancelled: the graphical manager never passes a cancellation token"
angle: connection-parity
severity: medium
category: reliability
is_workaround: false
subsystem: "src-tauri/src/session/graphical_manager.rs + core/src/backends/vnc"
evidence:
  - src-tauri/src/session/graphical_manager.rs:502
  - core/src/backends/vnc/tunnel.rs:207
  - core/src/backends/vnc/mod.rs:772
  - core/src/backends/vnc/mod.rs:796
  - core/src/backends/vnc/mod.rs:846
  - src-tauri/src/session/graphical_supervisor.rs:116
  - src-tauri/src/session/graphical_supervisor.rs:418
  - src/components/RemoteDesktop/RemoteDesktopOverlay.tsx:39
  - src/hooks/useRemoteDesktopSession.ts:254
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: previous-incomplete
previous_id: PARITY-007
---

## What

The PARITY-007 fix made Vnc::connect_cancellable race a CancellationToken. But GraphicalSessionManager::connect_inner calls plain connection.connect(settings) (graphical_manager.rs:502), with no token and no tokio timeout. Inside, the direct TcpStream::connect (tunnel.rs:207) and the RFB/VeNCrypt handshake (mod.rs:796, vendor/vnc-rs has no handshake timeout) are unbounded. A firewalled host waits out the OS TCP timeout (about 75 s on macOS, about 127 s on Linux). A peer that accepts TCP but never sends the RFB greeting hangs forever. The 'Connecting to X…' overlay has no Cancel button (RemoteDesktopOverlay.tsx:39, unlike the terminal connecting overlay). The session id is only returned after connect succeeds, so closing the tab cannot abort it either (useRemoteDesktopSession.ts:254 disconnects only after connect resolves). Reconnect attempts are bounded by RECONNECT_DIAL_TIMEOUT (30 s, graphical_supervisor.rs:418), so only the first connect is unbounded.

## Why it matters

The PARITY-007 resolution says VNC and RDP connects can be cancelled, but no desktop caller passes a token, so that fix never takes effect for graphical sessions. Terminal backends get both a connect timeout and a working Cancel. A VNC tab can sit in Connecting with no way out, and a stalled handshake leaks its socket and task for the life of the app.

## Recommendation

In connect_inner, register a CancellationToken in a connecting map under a frontend-supplied connect id (the same pattern SessionManager uses with cancel_connecting). Call connection.connect_cancellable(settings, Some(token)) inside tokio::time::timeout, reusing RECONNECT_DIAL_TIMEOUT or adding a connectTimeoutSecs field to the shared graphical field base. Pass a connectId from remoteDesktopConnect and add a Cancel button to the connecting/authenticating overlay that fires it. Unmounting the tab should cancel it too.

## Verification

Confirmed. graphical_manager.rs:502 calls plain connection.connect(settings), with no CancellationToken and no tokio timeout. The direct VNC path in tunnel.rs:207 is a bare TcpStream::connect, and the VNC backend has no handshake timeout anywhere (grep finds none). RemoteDesktopOverlay shows Cancel only in the reconnecting state; the connecting/authenticating state has none. useRemoteDesktopSession receives the session id only after remoteDesktopConnect resolves, so the tab cannot abort a connect that is still in flight. The PARITY-007 cancellation never takes effect for desktop graphical sessions.
