---
id: CORE-013
title: Remote file readers buffer the entire file in memory with no size cap (SSH & Docker)
angle: backend-core-rust
severity: medium
category: reliability
is_workaround: false
subsystem: core/backends
evidence:
  - core/src/backends/ssh/file_browser.rs:250
  - core/src/backends/docker/file_browser.rs:204
status: fixed
resolution: "#2780 — remote read cap"
---

## What
Both remote file browsers slurp a whole remote file into memory with no upper
bound. SSH:

```rust
let mut data = Vec::new();
file.read_to_end(&mut data).await
    .map_err(|e| FileError::OperationFailed(format!("read failed: {e}")))?;
Ok(data)
```

Docker reads via `base64` exec, accumulating the full base64 stream (~1.33× the
file size) into a `Vec`, then decoding into another `Vec`.

## Why it matters
A large file — or a hostile server/daemon advertising or streaming a huge one —
exhausts host memory. There is no `stat`-and-reject, no streaming, and no
configurable ceiling on either path, so opening a multi-GB file in the file
browser can OOM the desktop app.

## Evidence
`core/src/backends/ssh/file_browser.rs:250-255` (`read_file`, also `write_file`);
`core/src/backends/docker/file_browser.rs:204-216` plus `exec_command`
accumulation.

## Recommendation
`stat` first and reject files above a configurable limit, or stream the transfer
with a bounded `take()`/chunked read that errors past a max size. Share one size
policy across backends.
