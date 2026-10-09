---
id: PARITY2-001
title: "RDP 'Test connection' reports success without ever contacting the server"
angle: connection-parity
severity: medium
category: correctness
is_workaround: false
subsystem: "core/src/backends/rdp_sidecar + src-tauri/src/session/manager.rs (test_connection)"
evidence:
  - src-tauri/src/session/manager.rs:952
  - src-tauri/src/session/manager.rs:1003
  - src-tauri/src/session/manager.rs:1013
  - core/src/backends/rdp_sidecar/mod.rs:686
  - core/src/backends/rdp_sidecar/mod.rs:733
  - core/src/backends/rdp_sidecar/mod.rs:782
  - rdp-sidecar/src/rdp.rs:167
  - src/components/ConnectionEditor/ConnectionEditor.tsx:1853
  - src/components/ConnectionEditor/ConnectionEditor.tsx:1362
status: fixed
resolution: "#4320 — Test connection awaits the RDP sidecar's first definitive outcome (active, typed failure, timeout, untrusted certificate)"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

SessionManager::test_connection checks a connection by calling connect_cancellable and treating Ok as success, then disconnects. SidecarRdp::connect returns Ok as soon as the helper process has started and the Connect message is written to its stdin (mod.rs:733 to 782). The TCP connect, TLS, certificate check and CredSSP/NLA all run later inside the sidecar (rdp.rs:167 onward), and failures there only appear afterwards through fatal_error(). The editor shows the Test button for direct RDP connections (it is hidden only for agent-tunnelled graphical connections, ConnectionEditor.tsx:1853). So for RDP, Test shows 'Connection successful — Reached X' for an unreachable host, a wrong port or a wrong password. SSH, FTP, telnet and VNC (which does the full RFB handshake and auth inside connect) all return a real verdict.

## Why it matters

Test connection exists to confirm reachability and credentials before saving. For RDP it always says yes, so the user is told a broken configuration works. They only find out when the real session fails, which defeats the feature. Medium because RDP is still behind the experimental gate.

## Recommendation

For graphical types in test_connection, after connect returns, wait for the backend's first definitive outcome before disconnecting: the first frame or an Active signal from the sidecar counts as success, and fatal_error() or a closed frame stream counts as failure. Bound the wait (for example 30 s) and keep it cancellable through the existing connecting token. Alternatively, add an RDP-specific probe message that tells the sidecar to run the connect up to the end of CredSSP and report back. If neither is done for 0.1, hide the Test button for type 'rdp' so it cannot give a false positive.

## Verification

Confirmed. SessionManager::test_connection (manager.rs:952-1020) takes Ok from connect_cancellable as the verdict, then disconnects. SidecarRdp::connect (rdp_sidecar/mod.rs:686-782) returns Ok as soon as the helper has spawned and the Connect message is written to its stdin. The doc comment on connect_cancellable says outright that the transport, TLS and auth steps run inside the sidecar and are reported asynchronously. RDP is registered in the desktop registry (session/registry.rs:73-78), and the editor hides the Test button only for agent-tunnelled graphical connections (ConnectionEditor.tsx:1853). So Test reports success for an unreachable host or a wrong password. Medium is right while RDP stays experimental.
