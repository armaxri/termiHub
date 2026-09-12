---
id: PKG-010
title: No [profile.release] — shipped binaries are not stripped and use no LTO (larger bundles, symbol names retained)
angle: packaging-release
severity: low
category: perf
is_workaround: false
subsystem: Cargo.toml
evidence:
  - Cargo.toml:45
status: open
---

## What
The workspace `Cargo.toml` defines only `[profile.dev]` (`debug = 0`, for disk
hygiene). There is **no `[profile.release]`**, so release artifacts use Cargo's
defaults: `opt-level = 3`, `lto = false`, `codegen-units = 16`, `strip = false`,
`panic = "unwind"`. Cargo's release default already omits DWARF debug info
(`debug = false`), so the concern is not debug symbols — it is that the **symbol
table is not stripped** and no size/perf hardening (LTO, single codegen unit, strip)
is applied to the shipped desktop binary, agent binaries, or the RDP sidecar.

## Why it matters
Unstripped release binaries are meaningfully larger (function/symbol names retained)
and leak internal symbol names into the shipped artifact. For a multi-binary bundle
(desktop + agent + rdp-helper + X-server helpers) shipped to end users this is
avoidable bloat. Low severity — not a correctness or security blocker — but easy
bundle hygiene to fix before v1.0.

## Evidence
- `Cargo.toml:45-46` — only `[profile.dev] debug = 0`; grep for `[profile` finds no
  `release` (or `release.package`) section anywhere in the workspace manifest.
- The RDP sidecar is a separate cargo unit (`rdp-sidecar/Cargo.toml`) and would need
  its own release profile too.

## Recommendation
Add a `[profile.release]` with at least `strip = true` (or `strip = "symbols"`) and
consider `lto = "thin"` + `codegen-units = 1` for the final release build. Measure the
size/build-time trade-off. Apply the same to the excluded `rdp-sidecar` crate. Keep
`panic = "unwind"` unless a size-driven `abort` is deliberately chosen (it changes
crash behaviour). Verify agent binaries (built via `cross`/`cargo build --release`)
pick up the profile.
