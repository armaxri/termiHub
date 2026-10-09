---
id: DUP2-008
title: "The agent-routed VNC/RDP forward recomputes target port and relay chunk size from copied constants instead of core VncConfig/RdpConfig::effective_port and AGENT_FORWARD_CHUNK_SIZE"
angle: code-duplication
severity: low
category: duplication
is_workaround: false
subsystem: "src-tauri/src/session/agent_port_forward.rs"
evidence:
  - src-tauri/src/session/agent_port_forward.rs:37
  - src-tauri/src/session/agent_port_forward.rs:44-47
  - src-tauri/src/session/agent_port_forward.rs:81-122
  - core/src/backends/vnc/config.rs:29
  - core/src/backends/vnc/config.rs:187-192
  - core/src/backends/rdp_sidecar/config.rs:30
  - core/src/backends/rdp_sidecar/config.rs:211-217
  - core/src/backends/ssh/agent_forward.rs:30
status: fixed
resolution: "#4284 — agent_route resolves the port via core VncConfig/RdpConfig::effective_port and the forward reads in AGENT_FORWARD_CHUNK_SIZE"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`agent_route` promises the agent 'connects exactly where a direct connection would', but does so with its own copies: `VNC_BASE_PORT = 5900` (commented 'mirrors the VNC backend's VNC_BASE_PORT'), `RDP_DEFAULT_PORT = 3389`, and a hand-written display, then port, then default rule over raw `serde_json::Value` lookups (`read_u16` also accepts numeric strings). Core already has `vnc::config::VNC_BASE_PORT`, `VncConfig::effective_port`, `rdp_sidecar::config::RDP_DEFAULT_PORT` and `RdpConfig::effective_port`, the functions the direct path uses. The rules already differ. Core VNC with `port: 0` and no display dials port 0, while the route substitutes 5900. Core's typed deserializer rejects a string port that the route accepts. Separately, `FORWARD_CHUNK_SIZE = 64 * 1024` ('the relay's own chunk size') repeats the constant DUP-004 centralized as `AGENT_FORWARD_CHUNK_SIZE`.

## Why it matters

The direct and agent-routed paths can resolve different targets for the same saved connection, and a future change to VNC or RDP port rules, such as a new display-offset rule, will silently miss the agent path. The relay chunk is coupled to the agent's line cap after base64, which is exactly what DUP-004 removed the copy for.

## Recommendation

In `agent_route`, deserialize the settings into `VncConfig`/`RdpConfig` (both are `#[serde(default)]`) and call `effective_port()`. Use `VncConfig::use_ssh_tunnel` for the tunnel check. Import `AGENT_FORWARD_CHUNK_SIZE` instead of redeclaring it. Add a parity test that runs the same settings through the direct and routed resolvers.

## Verification

Confirmed. agent_port_forward.rs redeclares VNC_BASE_PORT=5900, RDP_DEFAULT_PORT=3389 and FORWARD_CHUNK_SIZE=64KiB, and uses hand-rolled read_u16 over a Value (accepting numeric strings). Core's VncConfig::effective_port returns self.port when there is no display, including 0, while the route maps 0 to 5900, so the divergence is real. One caveat: AGENT_FORWARD_CHUNK_SIZE belongs to ssh-agent forwarding, a different relay, so that part of the claim is weaker.
