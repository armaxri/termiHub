---
id: WA-RS-012
title: RDP host-clipboard file reading is macOS-only; Windows/Linux deferred
angle: workaround-rust
severity: low
category: missing-feature
is_workaround: true
subsystem: rdp-sidecar/clipboard
evidence:
  - rdp-sidecar/src/clipboard.rs:72
status: open
---

## What
The RDP sidecar's host-clipboard file-copy feature (offering the user's locally
copied files to the remote) reads the OS clipboard file list on macOS only:

```
//! Host-clipboard *reading* is macOS-only
//! for now (Windows `CF_HDROP` / Linux `text/uri-list` are sequenced follow-ups);
//! other platforms fall back to the shared-folder offer.
```

## Why it matters
A cross-platform feature is only implemented on one platform ("for now"), leaving
Windows and Linux RDP users on a degraded shared-folder path. It degrades
gracefully, so it is a completeness/parity gap rather than a defect — but the
"for now" marks unfinished work that should be tracked and closed before the
feature is considered done.

## Recommendation
Implement `CF_HDROP` reading on Windows and `text/uri-list` on Linux so the
`read_host_clipboard_files` path is symmetric across platforms, then delete the
"macOS-only for now" caveat. Ensure follow-up issues exist and are linked.
