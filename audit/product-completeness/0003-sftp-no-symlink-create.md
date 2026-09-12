---
id: PROD-003
title: Symlinks can be viewed but not created in the file browser
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: core/files, src/components/Sidebar/FileBrowser
evidence:
  - core/src/files/mod.rs:33
  - src/components/Sidebar/FileBrowser.tsx:371
status: open
---

## What
Symlinks are detected and displayed (`is_symlink`, `symlink_target`) but there is no
"create symbolic link" action; no backend exposes a `symlink()` op.

## Why it matters
Creating/repointing links is a common admin task; termiHub can only follow existing links.

## Evidence
- `core/src/files/mod.rs:33-42` — symlink fields for display.
- `src/components/Sidebar/FileBrowser.tsx:371-386, 502-509` — symlink rendering only.
- `symlink()` appears only in a test (`core/src/backends/wsl.rs:1462`).

## Recommendation
Add a `symlink(target, link_path)` trait op (SFTP `symlink`, local `std::os::unix::fs::symlink`)
and a "New symbolic link…" context-menu action.
