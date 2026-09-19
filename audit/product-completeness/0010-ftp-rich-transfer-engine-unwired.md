---
id: PROD-010
title: FTP has a full transfer engine (progress/ETA/resume/retry) that the UI never calls
angle: product-completeness
severity: high
category: bug
is_workaround: true
subsystem: src-tauri/src/files/transfer/ftp, src/hooks/useSessionFileSystem
evidence:
  - src-tauri/src/commands/transfer.rs:68
  - src/services/api.ts:1341
  - src/hooks/useSessionFileSystem.ts:336
status: open
---

## What
`ftp_download`/`ftp_upload` enqueue rich transfers with progress, ETA, REST-based resume and
backoff retry, and API wrappers `ftpDownload`/`ftpUpload` exist — but nothing in the frontend
calls them. FTP browsing instead uses the byte-based session path, loading whole files into
memory with no progress, no ETA, no resume, no pause.

## Why it matters
A complete, capable transfer engine sits dead behind an IPC surface with no callers, while
FTP users get the worst experience (in-memory whole-file transfers). Large FTP transfers may
exhaust memory and give no feedback. This is finished work hidden by a missing wiring.

## Evidence
- `src-tauri/src/commands/transfer.rs:68-190` — rich FTP transfer commands (eta_secs, speed_bps, REST resume).
- `src/services/api.ts:1341-1370` — `ftpDownload`/`ftpUpload` wrappers with no callers (grep: only defs + test mocks).
- `src/hooks/useSessionFileSystem.ts:41, 136-180, 336-337` — FTP falls back to whole-file `sessionReadFile`/`sessionWriteFile`.

## Recommendation
Wire the FTP browser's download/upload actions to `ftpDownload`/`ftpUpload` (the rich queue),
surfacing progress in the TransferQueue like SFTP is meant to. Delete the byte-path fallback
for FTP once wired.
