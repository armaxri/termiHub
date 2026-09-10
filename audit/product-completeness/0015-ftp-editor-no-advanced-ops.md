---
id: PROD-015
title: FTP-backed editing lacks writability probe and sudo-save affordances
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: core/backends/ftp, core/backends/ssh/file_browser
evidence:
  - core/src/backends/ssh/file_browser.rs:363
  - core/src/files/mod.rs:26
status: open
---

## What
`SftpAdvancedOps` (writability probe, realpath, elevated/sudo save) is SSH-only by design.
For FTP (and local/docker), the editor cannot probe writability or offer sudo-save; it falls
back to the coarse permission hint, and the "save with sudo" affordance is silently absent.

## Why it matters
Editing a non-writable file over FTP fails at save time with no upfront signal, versus the
richer pre-checks SSH users get. Mostly protocol-inherent but a visible parity difference.

## Evidence
- `core/src/backends/ssh/file_browser.rs:363-378` — advanced ops SSH-only ("local, docker, FTP cannot offer these").
- `core/src/files/mod.rs:26-30` — coarse permission hint fallback.

## Recommendation
Where the protocol allows, add a lightweight writability probe (attempt/allow flag) for FTP;
document the elevated-save limitation clearly in the editor for non-SSH backends.
