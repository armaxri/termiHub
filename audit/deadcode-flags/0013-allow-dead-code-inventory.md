---
id: DEAD-013
title: "#[allow(dead_code)] inventory — Rust markers classified for release"
angle: deadcode-flags
severity: low
category: arch
is_workaround: false
subsystem: core, src-tauri, agent
evidence:
  - src-tauri/src/utils/errors.rs:18
  - src-tauri/src/terminal/agent_manager.rs:220
  - src-tauri/src/layout/store.rs:213
  - src-tauri/src/terminal/xserver/manager.rs:18
status: in-progress
resolution: "#2785 — removable rust subset done; DEAD-012 + layout snapshot + retain_agent_config(#2472) remain; ConnectionFailed/AgentRpcClient kept (audit stale)"
---

## What
A catalogue of every `#[allow(dead_code)]` / `#![allow(dead_code)]` marker in the Rust
stacks, classified. Each marker is a deliberate "known dead" signpost; some are
legitimate, several are removable residue. The two most significant are broken out as
their own findings (DEAD-012 shell_integration; the layout scaffolding is DEAD-004).

## Classification

**Removable / speculative dead (recommend act):**
- `src-tauri/src/utils/errors.rs:18,22,32,36` — error enum variants `ConnectionFailed`,
  `SerialError`, `TelnetError`, `DockerError` are never constructed. Dead variants;
  remove or start using.
- `src-tauri/src/terminal/agent_manager.rs:220,223` — `agent_version` / `protocol_version`
  fields "stored for future version-gated checks" / "future protocol negotiation". Never
  read. Speculative; remove until a consumer exists.
- `src-tauri/src/terminal/agent_manager.rs:241` — `AgentRpcClient` trait held for a
  future "route through Arc<dyn AgentRpcClient>" refactor that has not happened. Dead
  abstraction.
- `src-tauri/src/layout/store.rs:213` — `snapshot()` explicitly "no longer published …
  kept … as a rollback seam" (#2283). Rollback scaffolding; remove once layout migration
  (DEAD-004) lands.
- `src-tauri/src/connection/shell_integration.rs:257,282,315` — see **DEAD-012**.

**Legitimate (leave; documented rationale holds):**
- `src-tauri/src/tunnel/tunnel_manager.rs:71` — `PooledSessionGuards` fields held purely
  for RAII `Drop`; correct use of the attribute.
- `src-tauri/src/terminal/agent_config_store.rs:124`, `agent/src/handler/dispatch.rs:226`
  — `#[cfg_attr(not(test), allow(dead_code))]`, test-only helpers.
- `src-tauri/src/spawn/registry.rs:290-363` — platform-conditional helpers with no
  non-test caller on some targets (documented).
- `core/src/backends/mock_remote_desktop.rs:51` — `host` field accepted "for editor
  parity" on the mock; tied to DEAD-001 (goes away if the mock backend leaves default).
- `core/src/backends/wsl.rs:311` (`windows_path_to_wsl_path`), `core/src/plugin/host.rs:157,383`
  (library-lifetime handle), `src-tauri/src/terminal/xserver/manager.rs:18`,
  `src-tauri/src/terminal/jsonrpc.rs:7`, `src-tauri/src/utils/x11_detect.rs:8` —
  platform-/feature-conditional; dead only on some targets. Verify no target keeps the
  whole `#![allow(dead_code)]` module fully dead.

## Why it matters
Each removable item is a small dead path; collectively they are the "future-proofing"
residue a workaround-free release wants trimmed. The module-level `#![allow(dead_code)]`
files (`xserver/manager.rs`, `jsonrpc.rs`, `x11_detect.rs`) are worth a closer look —
a blanket allow can hide a fully-dead module on the default build.

## Recommendation
Act on the "removable" list (delete dead error variants, speculative fields, the
`AgentRpcClient` trait, the layout rollback `snapshot`). Leave the "legitimate" set.
For the three `#![allow(dead_code)]` modules, confirm they carry live callers on at
least one shipped target; if not, they are fully dead and should be gated or removed.
