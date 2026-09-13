---
id: TAURI-003
title: unsafe std::env::set_var during setup() after Tauri may have spawned threads
angle: backend-tauri-rust
severity: medium
category: workaround
is_workaround: true
subsystem: lib.rs setup / portable mode
evidence:
  - src-tauri/src/lib.rs:490
  - src-tauri/src/lib.rs:491
status: open
---

## What

Portable-mode detection redirects the config dir by mutating a process environment variable
from inside `setup()`:

```rust
// Safety: called before any threads that read env vars are spawned.
#[allow(unused_unsafe)]
unsafe {
    std::env::set_var("TERMIHUB_CONFIG_DIR", data_dir);
}
```

`std::env::set_var` is `unsafe` (as of the 2024 edition) precisely because it is a data race
against any concurrent `getenv`/`setenv` in the process. By the time `setup()` runs, the Tauri
runtime, the async runtime, the logging subscriber, and (in test-bridge builds) the WebSocket
plugin are already up — the "before any threads that read env vars are spawned" precondition in
the comment is not obviously true. Several storage modules read `TERMIHUB_CONFIG_DIR` via
`std::env::var`, and any of them could run on another thread.

## Why it matters

A data race in `set_var`/`getenv` is UB on glibc and can crash (it walks/reallocates the
`environ` array without a lock). It is low-probability but it is on the *startup* path of a
safety-critical app, and the mitigating comment rests on an assumption that the code around it
no longer clearly satisfies.

## Evidence

- `lib.rs:486-495` — the portable-mode branch that calls `set_var`.
- Storage modules resolve the dir via `TERMIHUB_CONFIG_DIR` reads
  (`utils::config_paths::resolve_config_dir`), i.e. there are readers of this var.

## Recommendation

Stop using the environment variable as an in-process channel. Resolve the config dir once in
`setup()` and thread the resolved `PathBuf` explicitly to every manager constructor (most
already take `app.handle()` and could take the dir instead). The env var can remain a
*read-only* external override (`TERMIHUB_CONFIG_DIR` set by the launcher/tests), but the app
should never write it at runtime. If an env write is truly unavoidable, do it in `run()` before
`tauri::Builder` is constructed, where the single-threaded precondition actually holds.
</content>
