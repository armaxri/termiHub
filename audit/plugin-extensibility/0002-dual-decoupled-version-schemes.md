---
id: PLG-002
title: Two decoupled version schemes — manifest apiVersion "1.0" vs native ABI u32=4
angle: plugin-extensibility
severity: high
category: arch
is_workaround: false
subsystem: core/src/plugin
evidence:
  - core/src/plugin/manifest.rs:27
  - plugin-api/src/lib.rs:144
  - examples/plugins/echo-backend/manifest.json:8
  - core/src/plugin/host.rs:284
status: open
---

## What
The plugin system versions "the API" **twice, independently**, with two different
constants that happen to share the name `CURRENT_PLUGIN_API_VERSION`:

1. **Manifest `apiVersion`** — a string `"major.minor"`, host constant frozen at
   `"1.0"` (`core/src/plugin/manifest.rs:27`), gated with major-match +
   minor-≤-host semantics.
2. **Native ABI version** — a `u32`, currently `4` (`plugin-api/src/lib.rs:144`),
   gated by **exact** equality at load time (`host.rs:284`).

These are checked at completely different points, against completely different
numbers, and nothing links them. The manifest constant has **never** been bumped
past `1.0` even though the native ABI has gone `1 → 2 → 3 → 4` through four
documented breaking layout changes (#2018/#2024/#2030). Every example and fixture
manifest declares `"apiVersion": "1.0"` while its `cdylib` is compiled against ABI
`4`.

## Why it matters
- **The manifest gate is meaningless for native plugins.** A manifest saying
  `"1.0"` sails through `api_compatibility()` regardless of which native ABI its
  library targets. The real compatibility decision happens later, in the loader's
  `u32` check, which the manifest can neither express nor predict.
- **Two failure surfaces for one concept.** A stale native plugin (cdylib built
  against ABI 3, manifest still `"1.0"`) passes the manifest compat gate, installs,
  is marked `Installed/Active`-eligible, and then fails at library load with
  `IncompatibleAbi` → `PluginState::Error`. The user sees a generic load error, not
  the graceful "incompatible, auto-disabled with a notification" path
  (`manager.rs:reconcile_compatibility`) which keys only on the *manifest*
  apiVersion — and that never changes.
- **Author confusion.** An author has no way to know what `apiVersion` to write:
  the docs table says `major.minor` and the examples all say `"1.0"`, but the thing
  that actually governs load is a hidden `u32` they set by depending on a
  particular crate revision.

## Evidence
- `core/src/plugin/manifest.rs:27` — `pub const CURRENT_PLUGIN_API_VERSION: &str = "1.0";`
- `plugin-api/src/lib.rs:144` — `pub const CURRENT_PLUGIN_API_VERSION: u32 = 4;`
  (with doc history of the 2/3/4 breaking bumps at lines 122-143).
- `examples/plugins/echo-backend/manifest.json:8` — `"apiVersion": "1.0"` next to a
  cdylib that reports ABI 4 (`echo-backend/src/lib.rs:96-98`).
- `core/src/plugin/host.rs:284` — `if found != CURRENT_PLUGIN_API_VERSION` (the u32).

## Recommendation
Unify the two into one coherent scheme. Either:
- Derive the manifest `apiVersion` from the native ABI number (bump `"1.0"` in
  lockstep with the `u32`, so the manifest gate and the loader gate agree and the
  graceful auto-disable path actually fires on ABI skew), **or**
- Drop the manifest apiVersion gate for native plugins entirely and make the loader
  the single source of truth, having the packer stamp the built-against ABI into
  the manifest automatically so it is never author-typed.

Whichever, document one number and make the packaging tool set it, so an author
never hand-writes a version that the loader will silently override.
