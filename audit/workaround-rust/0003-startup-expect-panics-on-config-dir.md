---
id: WA-RS-003
title: App startup panics via .expect() on config/data directory creation
angle: workaround-rust
severity: medium
category: reliability
is_workaround: true
subsystem: src-tauri/lib.rs
evidence:
  - src-tauri/src/lib.rs:488
  - src-tauri/src/lib.rs:505
  - src-tauri/src/lib.rs:506
status: fixed
resolution: "#2734"
---

## What
The Tauri setup path creates the portable data dir and the app config dir with
`.expect()`, panicking the whole app if creation fails:

```rust
std::fs::create_dir_all(data_dir).expect("Failed to create portable data directory");
...
let config_dir = utils::config_paths::resolve_config_dir(Some(app.handle()))
    .expect("Failed to resolve app config directory");
std::fs::create_dir_all(&config_dir).expect("Failed to create config directory");
```

## Why it matters
On a read-only volume, a permissions problem, a full disk, or a portable-mode
`data/` dir the user cannot write, the app **crashes at launch with a panic**
instead of showing a recoverable error. For a portable/USB-stick deployment this
is a plausible real path. Violates the repo rule "No `.unwrap()` in production
code".

## Recommendation
Surface a user-visible startup error (dialog + log) and exit cleanly, or fall
back to a writable location, instead of `.expect()`. At minimum, return a
`Result` from setup and let the caller present the failure. Note `main.rs`/tokio
runtime `.expect()`s at the very entry point are more defensible (nothing can run
without them), but directory creation deserves a graceful message.
