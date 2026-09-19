---
id: PROD-004
title: Copy/paste of a directory to a remote is unsupported; remote copy is a client round-trip
angle: product-completeness
severity: high
category: missing-feature
is_workaround: true
subsystem: src/hooks/useSessionFileSystem
evidence:
  - src/hooks/useSessionFileSystem.ts:286
  - src/hooks/useSessionFileSystem.ts:318
  - src-tauri/src/files/local.rs:38
status: open
---

## What
Remote paste treats each clipboard entry as a single file. SFTP→SFTP copy is emulated by a
download-to-temp then re-upload; other backends round-trip the whole file through the client.
Pasting a *folder* onto a remote calls `read_file`/download on a directory path and fails —
there is no recursion and no server-side copy.

## Why it matters
Copying a directory between remote locations is a basic file-manager operation. Users will
hit an outright failure when pasting folders, and even single-file remote copies needlessly
pull bytes to the local machine (slow, and impossible for very large files with no local space).

## Evidence
- `src/hooks/useSessionFileSystem.ts:286-356` — single-file paste logic; `:318-331` temp download+upload; `:336-337` byte round-trip; `:355` cross-source explicitly unsupported.
- `src-tauri/src/files/local.rs:38-56` — local copy is recursive, so the gap is remote-only.

## Recommendation
Implement server-side recursive copy where the protocol allows (SFTP: walk + copy on the
server via exec, or a native copy op) and recurse directories in the paste path. At minimum,
detect directory paste and recurse client-side instead of failing.
