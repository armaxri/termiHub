---
id: PROD-012
title: Interrupted-transfer resume is FTP-only; SFTP restarts from zero
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src-tauri/src/files/transfer
evidence:
  - src-tauri/src/files/transfer/mod.rs:244
  - src-tauri/src/files/transfer/mod.rs:5
status: open
---

## What
REST-based resume exists only for FTP. SFTP `copy_chunked` restarts a transfer from offset 0.
With no queue persistence (PROD-011), no transfer resumes after an app restart.

## Why it matters
Resuming a partially transferred large file after a dropped connection is a headline SFTP
client feature (WinSCP/FileZilla). Restarting multi-GB transfers from zero is costly.

## Evidence
- `src-tauri/src/files/transfer/mod.rs:5-6` — REST resume path is FTP-only (`retry::resume_offset`).
- `src-tauri/src/files/transfer/mod.rs:244-270` — SFTP `copy_chunked` has no resume offset.

## Recommendation
Implement SFTP resume via `open` at an offset with size check (`pread`/seek), reusing the
retry/resume-offset machinery already built for FTP.
