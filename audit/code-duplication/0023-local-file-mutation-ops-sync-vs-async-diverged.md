---
id: DUP-023
title: Local file mutation ops exist as sync (src-tauri) and async (core) copies that have diverged
angle: code-duplication
severity: medium
category: bug
is_workaround: false
subsystem: src-tauri/files/local.rs vs core/files/local.rs
evidence:
  - src-tauri/src/files/local.rs:13
  - core/src/files/local.rs:240
  - src-tauri/src/commands/files.rs:67
status: open
---

## What

`mkdir` / `delete` / `rename` for the local filesystem are implemented twice: a sync set in
`src-tauri/src/files/local.rs` (called by the `local_*` Tauri commands) and the async originals on
`core::files::local::LocalFileBrowser`. The two have **already diverged behaviorally**:

- `mkdir`: src-tauri uses non-recursive `create_dir`; core uses `create_dir_all`.
- `delete`: src-tauri takes an `is_directory` hint from the caller; core self-detects via `stat`.
- The src-tauri versions skip the leading-`~` expansion that core added.

## Why it matters

Same operation, two code paths, already differing on recursion, directory detection, and tilde
expansion — so the desktop's direct local file ops behave differently from the same ops routed
through the shared `FileBrowser`. A fix (symlink handling, error mapping, path expansion) applied to
one won't reach the other. `category: bug` because the divergence is user-observable (e.g. `mkdir`
of a nested path).

## Evidence

- `src-tauri/src/files/local.rs:13` (`mkdir`), `:19` (`delete`), `:29` (`rename`).
- `core/src/files/local.rs:240` (`mkdir`), `:207` (`delete`), `:223` (`rename`).
- `src-tauri/src/commands/files.rs:67/73/79` — the callers.

## Recommendation

Route the desktop `local_*` commands through `LocalFileBrowser`, or add thin sync wrappers in
`core::files::local` that both the browser and the command layer call, so there is one behavior for
each op. (Browsing/list/path-utils are already correctly centralized — this is the mutation gap.)
