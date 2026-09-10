---
id: WA-RS-014
title: Cluster of #[allow(dead_code)] attributes to periodically re-verify
angle: workaround-rust
severity: info
category: workaround
is_workaround: true
subsystem: src-tauri, core, agent (multiple)
evidence:
  - src-tauri/src/spawn/registry.rs:290
  - src-tauri/src/terminal/agent_manager.rs:220
  - src-tauri/src/utils/errors.rs:18
  - core/src/plugin/host.rs:157
  - agent/src/daemon/transport.rs:61
status: open
---

## What
~35 `#[allow(dead_code)]` attributes exist across the Rust tree. Spot-checking
(e.g. `spawn/registry.rs` cross-platform `cfg`-gated helpers) confirms most are
**legitimate**: a helper shared by `#[cfg(windows/macos/linux)]` arms has no
caller on some platforms and would otherwise trip `-D warnings`.

## Why it matters
`#[allow(dead_code)]` suppresses the compiler's unused-code signal. Where it is
cfg-justified it is correct; where it is masking genuinely-orphaned code, that
code is dead weight to remove before release. The two cases are indistinguishable
without reading each site, which is exactly why an allow-list drifts.

## Recommendation
Audit each `#[allow(dead_code)]` once: for cfg-gated cross-platform helpers, add
a short comment noting the platform arms that use it (some already have this);
for anything with no live caller on **any** platform, delete it. Consider a
periodic ratchet so new `#[allow(dead_code)]` requires a justifying comment.
Non-blocking, but a clean pre-release pass.
