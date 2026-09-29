---
id: PROD-055
title: Keyboard bindings can be exported only as a PDF cheat-sheet; no keymap import/round-trip
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: src/components/Settings/KeyboardSettings
evidence:
  - src/components/Settings/KeyboardSettings.tsx:264
status: fixed
resolution: "#3119 — keymap import/export: JSON Export/Import beside the HTML cheat-sheet in KeyboardSettings, reusing useJsonFile save/open dialog flow. New pure keybindingIo.ts (mirrors macroIo/themeIO): versioned envelope, lossless round-trip through the {action,key} persisted shape, validate-before-apply (malformed → error toast, existing bindings untouched)"
---

## What
The only export is a non-reimportable PDF cheat-sheet. Custom bindings persist in settings but
cannot be exported/imported/shared as a keymap file.

## Why it matters
Users expect to back up or share a customized keymap (or carry it between machines); a PDF
can't be reimported.

## Evidence
- `src/components/Settings/KeyboardSettings.tsx:264` — `exportCheatSheet` (PDF) only; no JSON import.

## Recommendation
Add keymap export/import as JSON alongside the PDF.
