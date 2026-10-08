---
id: I18N2-005
title: "Transfer pane Ctrl/Cmd+A select-all matches layout-mapped event.key, bypassing the I18N-011 physical-key matcher"
angle: i18n
severity: low
category: keyboard-layout
is_workaround: false
subsystem: "src/components/TransferView"
evidence:
  - src/components/TransferView/TransferPane.tsx:183
  - src/services/keybindings.ts:481
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: I18N-011
---

## What

`TransferPane`'s keydown handler checks `mod && e.key.toLowerCase() === "a"`.
The I18N-011 fix moved shortcut matching to physical `event.code` with an
`event.key` fallback (`eventMatchesCombo`), but this ad-hoc handler still
compares the layout-mapped character.

## Why it matters

On Cyrillic, Greek or Arabic layouts, Ctrl/Cmd+A yields `ф`, `α` and so on, so
select-all does nothing in the transfer pane while it works in the rest of the
app. The blast radius is one shortcut.

## Evidence

- `src/components/TransferView/TransferPane.tsx:183`
- `src/services/keybindings.ts:481`

## Recommendation

Match `e.code === "KeyA"`, falling back to `e.key` when `code` is empty, or
reuse the eventKeyMatches/eventMatchesCombo helper from services/keybindings.ts.
Separately, `src/utils/keybindingHelpers.ts`
(isCopyShortcut/isPasteShortcut/isSelectAllShortcut) has the same event.key
pattern and no non-test callers. Delete it so it is not reused.

## Verification

Confirmed. TransferPane.tsx:183 checks `mod && e.key.toLowerCase() === "a"`,
which compares the layout-mapped character. On non-Latin layouts it never
matches, unlike the eventMatchesCombo physical-code matcher from the I18N-011
fix. A grep found no non-test importers of keybindingHelpers, so the side note
about the unused helper module also holds. Only one shortcut is affected, so
low.
