---
id: PROD-063
title: No credential export / backup / migration path
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src-tauri/src/credential
evidence:
  - src-tauri/src/credential/crypto.rs:39
  - src-tauri/src/commands/credential.rs:39
status: fixed
resolution: "#3435, #3538 — encrypted vault export/import (Argon2id+AES-GCM, versioned, all-or-nothing import); keychain-mode export gated by fresh OS verification (Touch ID/Windows Hello) via #3538"
---

## What
There is no command to export/back up the credential vault, even though the encrypted-envelope
format documents an "export files" use case. The command surface covers only
status/unlock/reset/lock/setup/change/switch/set_auto_lock/store/resolve/remove.

## Why it matters
Users expect to back up or migrate their saved credentials to another machine. Without export,
moving to a new device means re-entering every secret, and a disk loss is unrecoverable.

## Evidence
- `src-tauri/src/credential/crypto.rs:39, 73` — reference "export files" / "export undecryptable".
- `src-tauri/src/commands/credential.rs:39-408` — no export/backup command.

## Recommendation
Add an encrypted vault export/import (password-protected envelope), reusing the documented
export-file format.
