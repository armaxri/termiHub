---
id: CORE-011
title: RDP sidecar integrity check is TOCTOU and can hash a different file than it spawns
angle: backend-core-rust
severity: medium
category: security
is_workaround: false
subsystem: core/backends/rdp_sidecar
evidence:
  - core/src/backends/rdp_sidecar/mod.rs:473
status: open
---

## What
The bundled sidecar binary is hashed and then spawned as two separate operations
against a possibly-relative path:

```rust
let helper = resolve_helper_binary();
...
integrity::verify_helper_integrity(&helper, override_active, integrity::EXPECTED_HELPER_SHA256)
    .map_err(SessionError::SpawnFailed)?;
let mut command = tokio::process::Command::new(&helper);
```

## Why it matters
Two problems on a security-critical pre-spawn gate:
1. **TOCTOU:** the file is hashed, then spawned in a later step — an attacker who
   can replace the file between check and exec bypasses verification entirely.
2. **Path mismatch:** when `resolve_helper_binary` returns the bare name
   (`PathBuf::from(HELPER_BIN_NAME)`), `sha256_hex_of_file` opens it relative to
   the CWD while `Command::new` resolves it via `PATH` — potentially two
   different files. In a release build (digest embedded) hashing a nonexistent
   relative path errors and refuses to spawn.

## Evidence
`core/src/backends/rdp_sidecar/mod.rs:473-501`, `integrity.rs:76`.

## Recommendation
Resolve the sidecar to an absolute path once, open a file handle, hash **that
handle**, and spawn from the same absolute path/handle (on Unix, exec the opened
fd). Never hash a bare/relative name that then spawns via `PATH`.
