---
id: PLG-013
title: No Rust-toolchain compatibility record/enforcement — the u32 ABI gate is insufficient for soundness
angle: plugin-extensibility
severity: medium
category: arch
is_workaround: false
subsystem: plugin-api, core/src/plugin/host.rs
evidence:
  - docs/plugin-authoring.md:232
  - plugin-api/src/info.rs:12
  - core/src/plugin/host.rs:266
status: open
---

## What
The ABI caveat states a native plugin is sound only when built against the same
major ABI **and** "a compatible Rust toolchain." The loader enforces the former (the
`u32` ABI gate) but there is **nothing** for the latter: `PluginInfo` records no
compiler/toolchain version, the loader never checks one, and no build metadata is
carried in the package. A plugin built with a mismatched toolchain that happens to
return the right ABI number passes every gate.

## Why it matters
The ABI's soundness rests on more than `#[repr(C)]` field layout. The design double-
boxes `Box<dyn Trait>` into a thin pointer, and — critically — relies on
`catch_unwind` at the FFI boundary to contain plugin panics
(`plugin-api/src/backend.rs:119`, `host.rs:204`). Panic/unwind behavior and the
representation of `std` types the plugin uses internally are toolchain-coupled. A
plugin built with an incompatible toolchain (different panic strategy, different std)
that returns ABI `4` would be accepted and could be undefined behavior — the exact
class of bug the whole `#[repr(C)]` design exists to prevent, reintroduced through
the one dimension nothing checks.

For a *safety-critical* release that loads native code from third parties, "sound
only with a compatible toolchain, and we neither record nor check the toolchain" is a
latent soundness gap, not just a DX one.

## Evidence
- `docs/plugin-authoring.md:224-235` — soundness explicitly conditioned on toolchain
  compatibility; no version given.
- `plugin-api/src/info.rs:12-23` — `PluginInfo` carries id/name/version/api_version;
  no compiler/toolchain field.
- `core/src/plugin/host.rs:266-289` — the only compatibility gate is the `u32` ABI
  number.

## Recommendation
Record the build toolchain (e.g. `rustc -Vv` / `RUSTC_VERSION`) in `PluginInfo` (an
append-only ABI addition) and have the loader warn or refuse on a toolchain the host
was not built/tested against, or at minimum publish the exact
supported/tested toolchain alongside the SDK (PLG-001) and pin it in the plugin
template. This is a precondition for treating the native ABI as a safe contract for
third-party binaries. (Complements the security expert's in-process/unsandboxed
finding: even a *cooperative, well-meaning* plugin can be UB on a toolchain skew the
system doesn't detect.)
