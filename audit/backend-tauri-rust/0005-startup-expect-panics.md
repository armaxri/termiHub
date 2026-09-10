---
id: TAURI-005
title: Startup .expect() on config-dir resolution panics the app instead of degrading
angle: backend-tauri-rust
severity: medium
category: reliability
is_workaround: false
subsystem: lib.rs setup
evidence:
  - src-tauri/src/lib.rs:488
  - src-tauri/src/lib.rs:505
  - src-tauri/src/lib.rs:506
status: open
---

## What

`setup()` goes to real lengths to degrade gracefully — every manager init records a
`RecoveryWarning` and continues on failure so "the app still starts but X is unavailable". But
a few early steps `.expect()` and hard-crash the whole app instead:

```rust
std::fs::create_dir_all(data_dir).expect("Failed to create portable data directory"); // :488
let config_dir = utils::config_paths::resolve_config_dir(Some(app.handle()))
    .expect("Failed to resolve app config directory");                                 // :505
std::fs::create_dir_all(&config_dir).expect("Failed to create config directory");      // :506
```

If the config directory cannot be resolved or created — a read-only volume, a permissions
problem, a full disk, an unexpected `TERMIHUB_CONFIG_DIR` pointing somewhere unwritable — the
app panics during `setup()` and never opens a window. There is no window, no error dialog, and
(depending on when the file-log opened) possibly no visible log.

## Why it matters

This is the one class of startup failure a user cannot recover from or even diagnose: the app
just won't launch. It is inconsistent with the surrounding recovery-warning philosophy, and it
is the kind of "won't boot on the customer's locked-down machine" failure that is very
expensive to debug in the field for a safety-critical product.

## Evidence

- `lib.rs:488,505,506` — three `.expect()` calls on filesystem/config-dir operations, versus
  the ~10 subsequent manager inits that all push a `RecoveryWarning` and continue.

## Recommendation

Treat config-dir failure like the other init failures: fall back to a temp/in-memory config
dir (the credential store, RDP/SSH trust stores already have `in_memory()` fallbacks) and push
a prominent `RecoveryWarning` ("running without persistent storage — settings will not be
saved"), so the app opens and can tell the user what is wrong. If a truly unusable environment
must abort, do it with a user-visible native error dialog and a logged reason, not a bare
`panic!` that dies silently.
</content>
