---
id: UISF-009
title: Raw radio/checkbox/select controls bypass ui primitives; no shared RadioGroup exists
angle: ui-shared-foundation
severity: medium
category: ui
is_workaround: false
subsystem: src/components/ui
evidence:
  - src/components/ExportImport/ExportDialog.tsx:91
  - src/components/WorkspaceSidebar/SaveWorkspaceDialog.tsx:92
  - src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:189
  - src/components/Settings/CustomizeLayoutDialog.tsx:187
  - src/components/Sidebar/AgentSetupDialog.tsx:423
  - src/components/Sidebar/AgentSetupDialog.tsx:392
  - src/components/PasswordPrompt/PasswordPrompt.tsx:82
  - src/components/Terminal/OpenSavedFileDialog.tsx:53
  - src/components/JumpHostSection.tsx:108
status: open
---

## What

`src/components/ui/` exports `Checkbox`, `Toggle`, and `Select`, but **no `RadioGroup`/`Radio`
primitive**. As a result:

- **Radio groups are hand-rolled** with raw `<input type="radio">` in at least 6 places, each with
  its own layout/label markup: `ExportDialog.tsx:91,101`, `SaveWorkspaceDialog.tsx:92,102`,
  `EmbeddedServerDialog.tsx:189,287,297`, `CustomizeLayoutDialog.tsx:187,226`,
  `AgentSetupDialog.tsx:423,442,471`.
- **Checkboxes are hand-rolled** with raw `<input type="checkbox">` where `ui/Checkbox` exists:
  `PasswordPrompt.tsx:82` ("Save password"), `OpenSavedFileDialog.tsx:53` ("Ask again" — which
  `ConfirmDialog`'s `dontAskAgain` already renders via `ui/Checkbox`), `CustomizeLayoutDialog.tsx:173,212,247`,
  `JumpHostSection.tsx:108`, and the EmbeddedServerDialog option checkboxes (`:252,261,271`).
- **A raw `<select>`** where `ui/Select` exists: `AgentSetupDialog.tsx:392` (`arch-select` target
  architecture) — `ui/Select` is used elsewhere in the app but hand-rolled here.

## Why it matters

`ui/Select` is a token'd Radix skin with keyboard nav, focus ring, and theming; the raw `<select>`
and raw radio/checkbox inputs get none of that consistently and re-implement label wiring each time.
The missing `RadioGroup` primitive is a genuine foundation gap — six features each solve
single-select-from-options differently (naming, keyboard behaviour, focus ring, disabled styling).

## Evidence

See frontmatter. Radio: 6 dialogs. Checkbox: 5+ sites bypass `ui/Checkbox`. Select:
`AgentSetupDialog.tsx:392-401`. `OpenSavedFileDialog.tsx:53` and `ConfirmDialog`'s built-in
`dontAskAgain` (ConfirmDialog.tsx:211-220) are the same control implemented two ways.

## Recommendation

Add a `RadioGroup`/`Radio` primitive to `src/components/ui/` (Radix RadioGroup skin, token'd).
Migrate the 6 radio sites, convert the raw checkboxes to `ui/Checkbox`, and swap
`AgentSetupDialog`'s `<select>` for `ui/Select`. Prefer `ConfirmDialog`'s `dontAskAgain` over
re-rendering an "ask again" checkbox by hand.
