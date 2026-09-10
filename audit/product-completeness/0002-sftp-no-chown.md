---
id: PROD-002
title: No ownership (chown/chgrp) support in the file browser
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: core/files
evidence:
  - core/src/files/mod.rs:16
  - core/src/files/browser.rs:27
status: open
---

## What
There is no chown/chgrp operation, and `FileEntry` does not even carry owner/group fields,
so ownership is neither shown nor editable.

## Why it matters
Admins managing remote hosts routinely need to see and change file ownership. Its total
absence (not even displayed) is a visible gap versus WinSCP/FileZilla/Cyberduck.

## Evidence
- `core/src/files/mod.rs:16-42` — no owner/group in `FileEntry`.
- No `chown` anywhere in the file-management path (`core/src/files`, backends).

## Recommendation
Add owner/group to `FileEntry` (SFTP `stat` already returns uid/gid) and a `chown` op to
the trait for backends that support it; surface in the properties/context menu.
