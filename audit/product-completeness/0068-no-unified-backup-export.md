---
id: PROD-068
title: Export/backup is fragmented per feature; no unified "back up everything"
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: src/components/ExportImport
evidence:
  - src/components/ExportImport/ExportDialog.tsx:48
status: open
---

## What
The Export dialog exports only connections (with or without encrypted credentials). Themes,
macros, workflows, and keyboard bindings each have (or lack) their own separate import/export;
there is no single "export all my config" backup and (per PROD-063) no credential-vault export.

## Why it matters
Migrating to a new machine or backing up requires the user to find and run several separate
export flows and remember which features even support it. A single backup/restore is the
expected way to move an app's full state.

## Evidence
- `src/components/ExportImport/ExportDialog.tsx:48` — `exportConnectionsEncrypted` only.
- Themes export via AppearanceSettings; macros/workflows via their own IO; keymap has none (PROD-055).

## Recommendation
Add a unified backup/restore (connections + settings + themes + macros + workflows + keymap,
optionally the credential vault) as one archive, alongside the per-feature exports.
