---
id: DUP-024
title: Recursive local file copy lives only in src-tauri, off the shared FileBrowser trait
angle: code-duplication
severity: low
category: arch
is_workaround: false
subsystem: src-tauri/files/local.rs
evidence:
  - src-tauri/src/files/local.rs:38
  - src-tauri/src/files/local.rs:59
  - core/src/files/browser.rs:27
status: open
---

## What

Recursive, symlink-preserving local copy (`copy_file`, `copy_dir_recursive`, `copy_symlink`) is
implemented only in `src-tauri/src/files/local.rs`. `copy` is **not on the `FileBrowser` trait** and
has no core home — generic filesystem logic (recursive walk, symlink preservation, parent-dir
creation) that sits in the desktop crate rather than the shared one.

## Why it matters

Not duplicated today, but it is latent: the first time a remote/agent copy feature is added, this
logic will be re-implemented against SFTP/agent instead of reused, forking a non-trivial algorithm.
Low now, rising the moment remote copy is wanted.

## Evidence

- `src-tauri/src/files/local.rs:38` (`copy_file`), `:59` (`copy_dir_recursive`), `:83`
  (`copy_symlink`).
- `core/src/files/browser.rs:27` — the `FileBrowser` trait (no copy capability).

## Recommendation

Move the recursive-copy free functions into `core::files::local`, and consider a `copy`/`copy_dir`
capability on `FileBrowser` so remote implementations get a single, shared algorithm to build on.
