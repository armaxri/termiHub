---
id: ARCH2-004
title: "ADR-19's 'no in-process plugin load' invariant is convention-only: termihub-core links and re-exports the runner's dlopen loader"
angle: architecture-overall
severity: low
category: arch
is_workaround: false
subsystem: "plugin-runner (lib), core/src/plugin"
evidence:
  - plugin-runner/src/lib.rs:25
  - plugin-runner/src/lib.rs:28
  - plugin-runner/src/loader/mod.rs:336
  - core/src/plugin/host.rs:36
  - core/Cargo.toml:147
  - core/Cargo.toml:153
  - core/Cargo.toml:363
  - core/tests/plugin_host_roundtrip.rs:28
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

ADR-19 says the host never `dlopen`s a native plugin and that 'there is no in-process load path left'. The plugin-runner crate is one library that host and runner both share. It publicly exports `loader::load_plugin_library` / `PreparedLibrary::load` (both call `Library::new` and then `plugin_init`) and the runner's self-confinement `sandbox` module (landlock and seccompiler on Linux). termihub-core depends on that library under its `plugin` feature, which the desktop enables. Core also depends directly on `libloading` and re-exports loader types (host.rs:36). Only convention keeps any host code from calling `load_plugin_library`; no feature gate, crate boundary or CI guard prevents it. The core integration tests already call it in-process (plugin_host_roundtrip.rs:28). core/Cargo.toml:152-155 and 358-361 still describe 'the in-process host' and say libloading is there 'to open a plugin's backend dynamic library', which is stale after ADR-19.

## Why it matters

This is the security boundary that closed SEC-002. Today, one future `load_plugin_library` call in host code, for example a 'quick probe' of a library's info, would compile without warnings and quietly bring back the inverted trust model ADR-19 removed. It would also run plugin initializers in the process that holds the decrypted vault. The desktop also links runner-only code it never needs (seccomp and landlock policy), which blurs which side owns which responsibility.

## Recommendation

Split the library by role. Gate the dlopen half (`load_plugin_library`, `PreparedLibrary::load`, `PluginLibrary`) and the self-confinement `sandbox` application behind a `runner` feature. Turn that feature on only for the binary (`required-features`) and for core's `[dev-dependencies]`. Keep the pure gates (`check_library_abi`, `check_library_toolchain`, `PinnedLibrary`, `ipc`) in the default build. Drop core's direct `libloading` dependency by mapping `LoadError::Open` to a string or opaque error. Add a cargo-tree or clippy `disallowed-methods` guard so non-test core/src-tauri code cannot reference `load_plugin_library`, and update the stale Cargo comments.

## Verification

Confirmed. plugin-runner's lib exports `loader` and `sandbox` without feature gates. Core's `plugin` feature pulls in termihub-plugin-runner and libloading directly (host.rs:153 uses libloading::Error), and host.rs re-exports loader types. Non-test core code only imports `loader` under cfg(test), so no in-process load exists today. The invariant is held by convention only, and the Cargo.toml comments ('the in-process host', 'to open a plugin's backend dynamic library') are stale after ADR-19. This is defense-in-depth hardening, not an exploitable hole; low.
