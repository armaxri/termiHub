---
id: UX-031
title: Shortcuts overlay is read-only with no link to the editor
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/KeyboardShortcuts
evidence:
  - src/components/KeyboardShortcuts/ShortcutsOverlay.tsx:82
  - src/components/Settings/KeyboardSettings.tsx:345
status: open
---

## What
The keyboard-shortcuts overlay (opened via F1 / Cmd+K Cmd+S) renders a static, searchable table
(`ShortcutsOverlay.tsx:82-136`) with **no edit affordance and no link to Settings → Keyboard**. The
actual editor — click-to-record, per-row Reset/Unbind, global reset, cheat-sheet export — lives
separately in `KeyboardSettings.tsx` (`:345` etc.). A user who opens the overlay to "change a
shortcut" hits a dead end with no hint that editing exists or where it lives.

## Why it matters
The most natural place a user looks to change a shortcut (the shortcuts overlay) offers no path to do
it. Full customization exists but is undiscoverable from the surface that lists the shortcuts. The
docs point users correctly (`docs/keyboard-shortcuts.md:5-7`), but the in-app overlay doesn't mirror
that pointer.

## Evidence
- `ShortcutsOverlay.tsx:82-136` — read-only table, no edit/link.
- `KeyboardSettings.tsx:345,351-375` — the editing UI, elsewhere.

## Recommendation
Add an "Edit shortcuts…" action to the overlay that opens Settings → Keyboard Shortcuts (or make the
overlay rows themselves editable). A single link closes the discoverability gap.
