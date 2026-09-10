---
id: PROD-001
title: SFTP browser cannot change file permissions (chmod) — mode is display-only
angle: product-completeness
severity: high
category: missing-feature
is_workaround: false
subsystem: core/files, src/components/Sidebar/FileBrowser
evidence:
  - src/components/Sidebar/FileBrowser.tsx:516
  - core/src/files/browser.rs:27
  - core/src/files/mod.rs:22
status: open
---

## What
The file browser renders POSIX permissions (`rwxr-xr-x`) but offers no way to change
them. The shared `FileBrowser` trait has no `chmod`/`set_permissions` operation, and the
UI shows the permission string read-only.

## Why it matters
Changing a file mode is a core SFTP/file-manager expectation (`chmod +x` a script, make
an SSH key `600`). A remote terminal hub without chmod forces users back to the shell for
a routine operation, undercutting the file browser's value.

## Evidence
- `src/components/Sidebar/FileBrowser.tsx:516-518` — `file-browser__permissions` rendered read-only.
- `core/src/files/browser.rs:27-48` — trait defines `list_dir/read_file/write_file/delete/rename/stat/mkdir`; no chmod.
- `core/src/files/mod.rs:22-30` — `FileEntry.permissions` is populated for display only.
- Repo-wide, `set_permissions` appears only in `core/src/bin/plugin_keygen.rs:85` (unrelated).

## Recommendation
Add a `set_permissions(path, mode)` to the `FileBrowser` trait (SFTP `setstat`, local
`std::fs::set_permissions`), surface a permissions editor in the row context menu with an
octal/checkbox UI. FTP/other byte backends that cannot chmod should hide the action.
