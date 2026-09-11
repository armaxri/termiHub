---
id: ERR-004
title: Startup .expect() on config-dir creation crashes the app at launch, contradicting the stated fallback intent
angle: error-handling
severity: high
category: reliability
is_workaround: true
subsystem: src-tauri/src/lib.rs (setup)
evidence:
  - src-tauri/src/lib.rs:488
  - src-tauri/src/lib.rs:505
  - src-tauri/src/lib.rs:506
  - src-tauri/src/lib.rs:1646
status: fixed
resolution: "#2794 — startup config/data dir degrade → RecoveryWarning (crash already gone; this surfaces it to user)"
---

## What
The Tauri `setup()` block resolves and creates the config/data directory with `.expect()`, so any failure is an immediate panic during launch with **no UI, no message, no recovery**:

```rust
std::fs::create_dir_all(data_dir).expect("Failed to create portable data directory");   // :488
let config_dir = utils::config_paths::resolve_config_dir(Some(app.handle()))
    .expect("Failed to resolve app config directory");                                    // :505
std::fs::create_dir_all(&config_dir).expect("Failed to create config directory");         // :506
```

The comment immediately above line 500 states the intended contract — *"Load settings to determine the credential storage mode. On failure, fall back to defaults so the app can still start."* — but the very next lines `.expect()` on the directory resolution/creation that the settings load depends on. **The code does the opposite of its own stated intent:** instead of degrading, it hard-crashes.

## Why it matters
- **Crash-on-launch on realistic edge environments**, none of them exotic: a portable install on read-only media (USB/CD, DMG still mounted read-only), a locked-down corporate profile where `%APPDATA%`/`~/.config` is not writable, a full disk, a config dir that exists as a *file* not a directory, or a roaming-profile race. In every case the user sees the app die instantly — on some platforms with no dialog at all — rather than a "couldn't create config directory, using temporary storage / here's the path to fix" message.
- **No portable-mode fallback.** Portable mode is a first-class feature (`utils/portable.rs`), and a read-only portable medium is exactly where `create_dir_all(data_dir)` at :488 fails — the feature's own happy-path assumption is a crash trigger.
- Ventilator-grade bar: launch is the one path that must never fail silently or fatally. A dead process with an English `expect` string flushed to stderr (which a GUI user never sees) is the worst-case error UX.

## Evidence
- `src-tauri/src/lib.rs:488,505,506` — three `.expect()` on directory resolve/create in `setup()`.
- `src-tauri/src/lib.rs:501–503` — comment promising graceful fallback that the code does not honour.
- (`:1646` `.expect("error while building tauri application")` is the terminal builder call — a genuinely unrecoverable state, lower concern, but should still surface a native dialog.)

## Recommendation
Make startup degrade instead of panic: on config-dir failure, fall back to a temp directory (or an in-memory/ephemeral config) and show a **native error dialog** (Tauri's dialog plugin works before the webview) naming the path and the OS error, so the user can fix permissions and relaunch. At minimum, replace `.expect()` with a match that logs the typed error and pops a blocking dialog rather than aborting the process. Mark `is_workaround` until the fallback exists.
</content>
