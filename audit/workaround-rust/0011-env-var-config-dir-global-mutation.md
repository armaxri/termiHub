---
id: WA-RS-011
title: Portable mode threads config dir through a global env var (set_var) instead of explicit config
angle: workaround-rust
severity: low
category: arch
is_workaround: true
subsystem: src-tauri/lib.rs, storage modules
evidence:
  - src-tauri/src/lib.rs:490
status: open
---

## What
Portable mode communicates the config directory to every storage module by
mutating a process-global env var at startup:

```rust
// Safety: called before any threads that read env vars are spawned.
#[allow(unused_unsafe)]
unsafe { std::env::set_var("TERMIHUB_CONFIG_DIR", data_dir); }
```

Storage modules then each read `TERMIHUB_CONFIG_DIR`.

## Why it matters
Global mutable env as an internal config channel is fragile: it relies on the
"before any threads read env vars" ordering comment being true forever (Rust
2024 made `set_var` `unsafe` precisely because this is racy), and it couples every
storage module to a magic env-var name rather than an injected config value. It
works today but is a stopgap for proper config threading.

## Recommendation
Resolve the config dir once into an `AppMode`/config struct and pass it explicitly
(via Tauri state / constructor args) to the storage modules, removing the
`set_var` and the per-module `TERMIHUB_CONFIG_DIR` reads. The env var can remain
as an *external* override input, read once, not as the internal transport.
