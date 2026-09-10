---
id: PARITY-001
title: Port-forwarding / tunnels are hard-coded SSH-only
angle: connection-parity
severity: high
category: arch
is_workaround: false
subsystem: src-tauri/src/tunnel
evidence:
  - src-tauri/src/tunnel/tunnel_manager.rs:1512
  - core/src/tunnel/config.rs:9
status: open
---

## What

Tunnel creation is gated on `conn.config.type_id != "ssh"` — every port-forward (local `-L`,
remote `-R`, dynamic SOCKS `-D`) can only be attached to an SSH connection. No other backend can
host a tunnel, and the restriction is expressed as a literal string comparison rather than as a
declared capability.

## Why it matters

- The `Capabilities` struct has flags for `monitoring`, `file_browser`, `graphical`, `resize`,
  `persistent`, `terminal` — but nothing for tunnelling, so this capability is invisible to the UI
  and cannot be reasoned about generically.
- Tunnelling is conceptually meaningful for the remote **agent** (an agent can forward ports from
  its own network — the code comments in `core/src/tunnel/config.rs` explicitly describe the
  "agent-hosted tunnel" case, and `core/src/tunnel` was moved into core specifically so the
  forwarder can run agent-side). The desktop path still refuses anything but a raw SSH connection,
  so the agent-hosted tunnel story is half-built.
- A string equality check is fragile: a future SSH-derived type, or an agent-proxied SSH
  connection whose stored `type_id` differs, would be rejected with a misleading "not an SSH
  connection" error.

## Evidence

`src-tauri/src/tunnel/tunnel_manager.rs:1512`:

```rust
if conn.config.type_id != "ssh" {
    return Err(TerminalError::TunnelError(format!(
        "Connection {} is not an SSH connection",
        connection_id
    )));
}
```

`core/src/tunnel/config.rs` documents an agent-hosted tunnel endpoint model
(`stateless-ui-agent-tunnel-endpoints.html`) that the desktop gate does not yet honour.

## Recommendation

Introduce a `tunnels: bool` (or `supports_forwarding`) capability on `Capabilities`, set it for SSH
(and agent-proxied SSH), and gate `create_tunnel` on the capability rather than a hard-coded
`type_id`. This keeps the SSH-only behaviour today but removes the string check and makes the
agent-hosted case (already designed in `core/src/tunnel`) reachable without another special-case.
