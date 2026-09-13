---
id: PARITY-005
title: FileBrowser trait has no permission-change (chmod) or copy operation
angle: connection-parity
severity: medium
category: missing-feature
is_workaround: false
subsystem: core/src/files/browser.rs
evidence:
  - core/src/files/browser.rs:27
  - core/src/backends/ssh/file_browser.rs:26
status: open
---

## What

The shared `FileBrowser` trait exposes exactly: `list_dir`, `read_file`, `write_file`, `delete`,
`rename`, `stat`, `mkdir`, plus a downcast escape hatch `as_any`. There is **no `chmod` /
set-permissions** and **no `copy`** in the shared surface, even though `FileEntry` carries a
permissions/mode field and remote listings (SFTP, FTP, Docker) all parse mode bits.

## Why it matters

- Changing permissions is a routine remote-file operation that a user reasonably expects from an
  SFTP/FTP browser. It is simply not expressible through the shared trait, so no backend offers it
  uniformly.
- SSH's SFTP browser *does* carry extra power (`SftpAdvancedOps`: `realpath`, `check_writable`,
  privilege-elevated write) but only reachable via the `as_any` downcast (#2312) — a per-backend
  side channel, not a capability every browser honours. This is the trait admitting it is
  incomplete: capabilities that don't fit get bolted on via downcasting instead of being modelled.
- The consequence is inconsistency: what you can do to a file depends on undocumented per-backend
  downcasts rather than a declared, uniform browser capability set.

## Evidence

- `core/src/files/browser.rs:27` — the full trait method list; no `chmod`/`copy`.
- `core/src/files/browser.rs:49` — the `as_any` downcast documented as the way to reach
  SFTP-specific advanced ops that "cannot live on this trait".
- A repo-wide search for `chmod` / `set_permissions` in `src-tauri/src/commands` and the trait
  returns no permission-change command.

## Recommendation

Either add `set_permissions`/`chmod` (and consider `copy`) to `FileBrowser` with a default
`Err(Unsupported)` for backends that cannot honour it (local/Windows, Docker), or formalise an
"advanced ops" sub-trait that a browser can optionally return — rather than an untyped `as_any`
downcast. The goal is that the set of operations a browser supports is declared and discoverable,
not discovered by attempting a downcast.
