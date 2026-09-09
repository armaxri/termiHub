---
id: UISF-015
title: SaveAsConnectionDialog collects a password via raw masked Input instead of shared PasswordInput
angle: ui-shared-foundation
severity: low
category: ui
is_workaround: false
subsystem: src/components/RecentSessionsSidebar
evidence:
  - src/components/RecentSessionsSidebar/SaveAsConnectionDialog.tsx:277
  - src/components/PasswordInput/PasswordInput.tsx
status: open
---

## What

`PasswordInput` is the shared masked password control (reveal toggle + Caps-Lock warning), used
correctly across JumpHostEntry, EmbeddedServerDialog, SecuritySettings, DynamicField, PasswordPrompt,
UnlockDialog, Export/Import, and SudoPrompt. `SaveAsConnectionDialog.tsx:277-284` is the one place a
password is collected with a plain `<Input type="password">` — no show/hide, no Caps-Lock warning.

## Why it matters

Inconsistent password affordance: everywhere else the user can reveal what they typed and is warned
about Caps Lock; here they cannot. It is a single, isolated regression from an otherwise
well-adopted primitive — cheap to fix and worth fixing so password entry behaves identically
everywhere.

## Evidence

`SaveAsConnectionDialog.tsx:277-284` — `<Input id="save-as-connection-password" type="password" …/>`
instead of `<PasswordInput …/>`.

## Recommendation

Swap the raw `<Input type="password">` for `PasswordInput`.
