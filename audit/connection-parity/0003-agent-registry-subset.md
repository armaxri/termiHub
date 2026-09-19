---
id: PARITY-003
title: Agent registry omits FTP/VNC/RDP/mock — agent connections are a subset of desktop
angle: connection-parity
severity: high
category: missing-feature
is_workaround: false
subsystem: agent/src/registry.rs
evidence:
  - agent/src/registry.rs:14
  - src-tauri/src/session/registry.rs:14
  - src-tauri/src/session/remote_proxy.rs:70
status: open
---

## What

The desktop registry (`build_desktop_registry`) registers local, serial, ssh, telnet, docker,
wsl (Windows), **ftp, mock-remote-desktop, vnc, rdp**. The agent registry (`build_registry`)
registers only local, serial, ssh, telnet, docker, wsl (Windows). FTP and all graphical backends
(VNC/RDP/mock) are **absent from the agent**.

## Why it matters

- A saved FTP or VNC/RDP connection that works when run locally silently cannot be run **through a
  remote agent** — the agent has no factory for that `type_id`, so `create` fails with
  "Unknown connection type". The two execution paths for the *same* connection type diverge.
- `RemoteMonitoringProxy`/`RemoteFileBrowserProxy` and `remote_proxy.rs` hard-code
  `graphical: false` for the proxied connection (`src-tauri/src/session/remote_proxy.rs:70`), so
  even if a graphical backend were registered agent-side, the proxy could not surface its
  framebuffer — the graphical path is desktop-only by construction.
- There is no UI signal for this cliff: the connection editor offers FTP/VNC/RDP regardless of
  whether the connection will be run locally or via an agent, so the failure only appears at
  connect time.

## Evidence

`agent/src/registry.rs` registers 5 (+wsl) types and its own test asserts `types.len() == 5`
(6 on Windows). The desktop `build_registry_returns_expected_types` asserts
`5 + wsl + ftp + mock + vnc + rdp`. `remote_proxy.rs:70` and `:125` both build the proxied
`Capabilities` with `graphical: false` hard-coded.

## Recommendation

Decide and document the intended agent surface, then make it consistent:

- If FTP/graphical are meant to be agent-runnable, register them in `agent/src/registry.rs` (FTP is
  pure-core and would just work; graphical needs the proxy to relay frames, a larger change).
- If they are deliberately desktop-only, gate them in the connection editor by execution target so
  the user cannot pick an agent for a type the agent cannot run, and surface a clear reason. Either
  way the current silent divergence between the two registries should not ship.
