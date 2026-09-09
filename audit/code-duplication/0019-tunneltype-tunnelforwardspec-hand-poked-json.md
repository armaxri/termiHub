---
id: DUP-019
title: TunnelType and TunnelForwardSpec are two serde representations bridged by hand-poked JSON tags
angle: code-duplication
severity: medium
category: reliability
is_workaround: true
subsystem: src-tauri/tunnel/config.rs + tunnel_manager.rs vs agent/protocol/methods.rs
evidence:
  - src-tauri/src/tunnel/config.rs:21
  - agent/src/protocol/methods.rs:700
  - src-tauri/src/tunnel/tunnel_manager.rs:766
status: open
---

## What

The 3-mode tunnel enum is modeled twice with different serde tagging: desktop `TunnelType`
(`#[serde(tag="type", content="config")]`) and agent wire `TunnelForwardSpec`
(`#[serde(tag="mode")]`, flattened). Both wrap the same core config structs. The desktop bridges
between them by serializing the inner config and **string-poking the tag**:
`forward["mode"] = json!("local"/"remote"/"dynamic")`.

## Why it matters

The literals `"local"`/`"remote"`/`"dynamic"` are hard-coded on the desktop to match the agent
enum's serde rename. If that rename ever changes, the bridge breaks **silently**, and the only
coverage is the CI-dark agent integration lane. `is_workaround: true` — mutating a `Value` to graft
a discriminator is a stopgap for not sharing the type. This is the tunnel-specific instance of the
DUP-001 protocol-DTO problem.

## Evidence

- `src-tauri/src/tunnel/config.rs:21-30` — `TunnelType` (`tag="type"`).
- `agent/src/protocol/methods.rs:700-713` — `TunnelForwardSpec` (`tag="mode"`).
- `src-tauri/src/tunnel/tunnel_manager.rs:766-790` — `forward["mode"] = json!(...)` bridge; literals
  at `:774/:781/:788`.

## Recommendation

Share one enum from the protocol home (DUP-001) and let the desktop construct/serialize
`TunnelForwardSpec` directly (type-checked), or define the conversion once as
`impl From<&TunnelType> for TunnelForwardSpec`. Eliminates the stringly-typed graft.
