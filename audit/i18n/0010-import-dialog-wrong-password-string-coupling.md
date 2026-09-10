---
id: I18N-010
title: Import dialog couples to backend's English "wrong password" text
angle: i18n
severity: low
category: bug
is_workaround: false
subsystem: src/components/ExportImport/ImportDialog
evidence:
  - src/components/ExportImport/ImportDialog.tsx:62
  - src-tauri/src/credential/crypto.rs:295
status: open
---

## What
The import dialog distinguishes a wrong-decryption-password error from other
failures by matching the message text `msg.includes("wrong password")`
(ImportDialog.tsx:62). That string is a termiHub-internal English constant
produced by the Rust credential crypto layer (crypto.rs).

## Why it matters
Bucket A but low blast radius. Because the string is termiHub's own constant
(not OS/remote text), it is stable in the English build — so this is more a
**coupling / readiness** defect than a live locale crash: the frontend silently
depends on the exact backend wording. It breaks the day either (a) that message
is localized as part of translation, or (b) anyone rewords the Rust error. The
failure mode is a wrong-password import being reported as a generic error,
losing the tailored "wrong password, try again" affordance.

## Evidence
- `src/components/ExportImport/ImportDialog.tsx:62` — `msg.includes("wrong password")`.
- `src-tauri/src/credential/crypto.rs:295` — the English source string.

## Recommendation
Return a structured/typed error kind from the decrypt path (e.g. a
`DecryptError::WrongPassword` variant surfaced as a stable code on the IPC error)
and switch on that in the dialog. Then the English text is free to be translated
without breaking the UI. Part of the broader "classify by code, not by message"
remedy shared with I18N-001/002/008/009.
