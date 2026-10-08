---
id: DUP2-004
title: "Windows current-user SID and protected-DACL FFI is duplicated in core::ipc::local_socket and plugin-runner's pipe; only the runner copy fixed the TOKEN_USER alignment"
angle: code-duplication
severity: medium
category: duplication
is_workaround: false
subsystem: "core/src/ipc/local_socket.rs (Windows) + plugin-runner/src/ipc/pipe.rs (Windows)"
evidence:
  - core/src/ipc/local_socket.rs:709-768
  - core/src/ipc/local_socket.rs:773-783
  - core/src/ipc/local_socket.rs:825-847
  - plugin-runner/src/ipc/pipe.rs:430-480
  - plugin-runner/src/ipc/pipe.rs:494-520
  - core/Cargo.toml:156
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Two separate unsafe Win32 copies build a per-user named-pipe security descriptor. Each has its own OpenProcessToken, GetTokenInformation(TokenUser), ConvertSidToStringSid, an `D:P(A;;GA;;;<sid>)…` SDDL string, ConvertStringSecurityDescriptorToSecurityDescriptorW, a SECURITY_ATTRIBUTES owner, LocalFree on drop, and its own `to_wide` helper. One is core's `SecurityAttributes::for_current_user` with `sid_string_from_token`. The other is plugin-runner's `security::Descriptor::granting` with `current_user_sid`. They have already diverged. The runner stores the TokenUser buffer as `Vec<u64>` ('keeps the TOKEN_USER header pointer-aligned'), but core still uses `vec![0u8; len]` and dereferences `&*(buf.as_ptr() as *const TOKEN_USER)` (local_socket.rs:833-839). That creates a reference to an under-aligned TOKEN_USER (which contains a pointer), which is undefined behaviour in Rust even though the system allocator usually returns 8-byte-aligned memory.

## Why it matters

Both copies are trust-boundary code: the per-user DACL is the AGT-022 protection for every agent and daemon IPC endpoint, and the runner pipe isolates sandboxed plugins. Keeping two unsafe copies means hardening applied to one, like the alignment fix, does not reach the other. Any future change, such as adding an integrity label or an LPAC SID, has to be made twice.

## Recommendation

Extract one Windows helper, e.g. `current_user_sid_string()` plus `PipeSecurity::granting(&[extra SIDs], include_system: bool)`, into a small leaf crate that depends only on windows-sys and that both plugin-runner's library and core depend on unconditionally. core's dependency on plugin-runner is optional (core/Cargo.toml:156), so it cannot live there. Until then, at least move core's TokenUser buffer to `Vec<u64>` storage as the runner did.

## Verification

Confirmed. core local_socket.rs sid_string_from_token uses `vec![0u8; len]` and `&*(buf.as_ptr() as *const TOKEN_USER)`. plugin-runner pipe.rs current_user_sid uses Vec<u64> with an explicit alignment comment. The two are parallel unsafe SDDL/DACL builders, and core's dependency on plugin-runner is optional (Cargo.toml:156), so the dedup has to go in a leaf crate. In practice the alignment UB is masked by the allocator, but the security-boundary divergence is real.
