---
id: CORE-037
title: Local file browser mislabels a symlink-to-directory (metadata vs symlink_metadata)
angle: backend-core-rust
severity: low
category: bug
is_workaround: false
subsystem: core/files
evidence:
  - core/src/files/local.rs
status: fixed
resolution: "#2848 — local file browser: symlink-to-dir now is_symlink=true + is_directory=true (navigable) via shared resolve_entry_metadata (no-follow flag + follow for is_dir); dangling/loop degrade gracefully; both list+stat builders"
---

## What
The local file browser's entry construction determines `is_directory` /
`is_symlink` in a way that mislabels a symlink pointing at a directory (reported
by the plugin/files audit) — mixing `metadata` (follows links) with
`symlink_metadata` (does not) inconsistently.

## Why it matters
A symlink to a directory can be reported as a plain directory (or its symlink
flag lost), so the UI navigates/treats it incorrectly and loop-forming symlinks
are not flagged. It is a correctness inconsistency in the shared FileEntry mapping
used across backends.

## Evidence
`core/src/files/local.rs` entry-building path (the `is_directory` / `is_symlink` /
`symlink_target` derivation).

## Recommendation
Use `symlink_metadata` to detect the symlink and set `is_symlink`, then a separate
`metadata` (follow) call to decide `is_directory` of the target, and record the
target explicitly — matching the FTP listing parser's symlink handling.
