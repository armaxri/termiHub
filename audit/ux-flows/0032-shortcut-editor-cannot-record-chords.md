---
id: UX-032
title: Shortcut editor cannot record chord bindings, though the app ships and supports them
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/Settings
evidence:
  - src/components/Settings/KeyboardSettings.tsx:302
  - src/services/keybindings.ts:63
status: open
---

## What
The shortcut recorder captures a single `KeyCombo` on the first non-modifier keypress
(`KeyboardSettings.tsx:302-326`). But the app ships a chord default (Show Shortcuts = Cmd+K Cmd+S,
`keybindings.ts:63-66`) and the engine supports chords (`processKeyEvent`, `keybindings.ts:605-643`).
So a user **cannot rebind anything to a chord** through the UI — the recorder collapses to the first
combo.

## Why it matters
A documented, shipped capability (chord bindings) is unreachable via customization. A user who wants
to set or change a chord shortcut simply can't, and a user trying to *re-record* the existing chord
default would inadvertently reduce it to a single combo. This is a capability/UI mismatch on the
shortcuts surface.

## Evidence
- `KeyboardSettings.tsx:302-326` — records one combo, no chord capture.
- `keybindings.ts:63-66` — a chord ships as a default.
- `keybindings.ts:605-643` — the engine supports chords.

## Recommendation
Extend the recorder to capture chord sequences (accumulate combos until a short timeout or an
explicit "finish"), matching what the engine already executes and the defaults already use.
