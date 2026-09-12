---
id: PARITY-004
title: File-transfer progress/pause/resume is uneven across SFTP / FTP / Docker
angle: connection-parity
severity: medium
category: missing-feature
is_workaround: false
subsystem: src-tauri/src/files/transfer
evidence:
  - src-tauri/src/files/transfer/mod.rs:1
  - src-tauri/src/files/transfer/ftp.rs:8
  - core/src/backends/docker/file_browser.rs:204
  - core/src/backends/ftp/transfer.rs:99
status: open
---

## What

Four backends expose a file browser (local, SFTP, Docker, FTP + WSL), but the *transfer* experience
behind that browser differs sharply:

- **FTP** has the full rich queue model (#1336): per-session bounded concurrency, **pause/resume**,
  auto-retry with exponential backoff, and `REST`-based resume of a partial transfer.
- **SFTP** has only the legacy single-phase cancellable chunked copy (#1245) — cancel works, but
  there is **no pause/resume and no retry/resume-offset**; a dropped SFTP transfer restarts from 0.
- **Docker** has no progress transfer path at all: `DockerFileBrowser` implements `read_file` /
  `write_file` as whole-file `docker exec cat`/redirect operations, with no chunking, progress
  events, cancel, or resume.
- **Local** browsing likewise has no progress-tracked transfer executor.

## Why it matters

- Same UI affordance (a file browser with upload/download), materially different behaviour per
  backend: a large download can be paused/resumed over FTP, only cancelled over SFTP, and neither
  over Docker. Users cannot predict which controls will work.
- The transfer subsystem describes itself as the "backend-agnostic transfer queue model" but only
  FTP is actually driven through it; SFTP stayed on the older path and Docker/local never joined.
- A whole-file Docker `read_file`/`write_file` also risks buffering large files entirely in memory.

## Evidence

- `src-tauri/src/files/transfer/mod.rs:1` header: "the SFTP path is unchanged and remains fully
  backward-compatible" — i.e. the rich `pause/resume/retry` model drives **FTP**, SFTP stays
  single-phase. `retry.rs` exposes `resume_offset` used by the FTP `REST` path only.
- `core/src/backends/ftp/transfer.rs:99` — `resume_transfer(offset)` (`REST`) for FTP.
- `core/src/backends/docker/file_browser.rs:204` — Docker `read_file`/`write_file` are whole-file
  exec operations, no progress/resume.

## Recommendation

Unify onto the queue model: route SFTP (and eventually Docker/local) through the same
`state`/`scheduler`/`retry` machinery so pause/resume/auto-retry are backend-agnostic, with each
backend supplying only its chunked read/write + resume-offset primitive. At minimum, bring SFTP to
parity with FTP (pause/resume/retry) since both are first-class remote file backends.
