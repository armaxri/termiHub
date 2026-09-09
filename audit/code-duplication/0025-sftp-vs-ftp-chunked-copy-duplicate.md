---
id: DUP-025
title: SFTP chunked-copy loop duplicates core's FTP chunked-copy primitive (and the 256 KiB chunk const)
angle: code-duplication
severity: medium
category: arch
is_workaround: false
subsystem: src-tauri/files/transfer vs core/backends/ftp/transfer
evidence:
  - src-tauri/src/files/transfer/mod.rs:251
  - src-tauri/src/files/transfer/mod.rs:50
  - core/src/backends/ftp/transfer.rs:27
status: open
---

## What

The SFTP transfer path has its own "read chunk → check cancel → write chunk → throttled progress"
engine (`copy_chunked`, `CHUNK_SIZE = 256*1024`), while core already owns an equivalent chunked-copy
primitive for FTP (`run_attempt`, `FTP_CHUNK_SIZE = 256*1024`). Two parallel streaming-copy loops
plus a duplicated 256 KiB chunk constant. The `SftpTransferChannel` handles already implement
`AsyncRead`/`AsyncWrite`, so the SFTP loop is a generic `copy_chunked<R: AsyncRead, W: AsyncWrite>`
that is merely pinned in the desktop crate.

## Why it matters

Progress-throttle cadence, cancel granularity, and chunk size can drift between the two protocols'
transfer paths, so a fix (e.g. cancel latency, progress accuracy) reaches one and not the other.
Medium.

## Evidence

- `src-tauri/src/files/transfer/mod.rs:251` (`copy_chunked`), `:50` (`CHUNK_SIZE = 256*1024`),
  driven by `run_download` :316 / `run_upload` :353.
- `core/src/backends/ftp/transfer.rs` (`run_attempt`), `:27` (`FTP_CHUNK_SIZE = 256*1024`).
- `core/src/backends/ssh/file_browser.rs:195/207` — `SftpTransferChannel` `AsyncRead`/`AsyncWrite`.

## Recommendation

Extract one generic streaming-copy primitive `copy_chunked<R: AsyncRead, W: AsyncWrite>(…, progress,
should_stop)` with a single `CHUNK_SIZE` into `core` (e.g. `core::files::transfer` or beside
`core::backends::ftp::transfer`), and drive both the SFTP path and `run_attempt` from it.
