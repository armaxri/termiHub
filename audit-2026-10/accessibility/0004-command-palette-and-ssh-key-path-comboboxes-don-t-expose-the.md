---
id: A11Y2-004
title: "Command palette and SSH key-path comboboxes don't expose the active option (no aria-activedescendant)"
angle: accessibility
severity: medium
category: screen-reader
is_workaround: false
subsystem: "src/components/CommandPalette, src/components/Settings/KeyPathInput"
evidence:
  - src/components/CommandPalette/CommandPalette.tsx:353-363
  - src/components/CommandPalette/CommandPalette.tsx:382-388
  - src/components/Settings/KeyPathInput.tsx:166-182
  - src/components/Settings/KeyPathInput.tsx:194-210
  - src/components/Settings/KeyPathInput.tsx:222-229
status: fixed
resolution: "#4330 — palette, key-path and quick-connect comboboxes expose aria-activedescendant, aria-controls, real aria-expanded and an announced validation hint"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Both widgets keep DOM focus in a role="combobox" input and move a highlighted index with the arrow keys. Neither sets aria-activedescendant, and the role="option" <li>s have no id to point at, so aria-selected changes on an element that never receives focus. KeyPathInput also omits aria-controls entirely, and the command palette hard-codes aria-expanded to true. KeyPathInput's validation message <p> (key not found / unreadable) has no id or live region, so it is never announced or associated with the input. TransferPane.tsx:298 shows the correct pattern already exists in the codebase.

## Why it matters

WCAG 4.1.2 Name, Role, Value (A) and 1.3.1. When arrowing through the palette, a primary keyboard-driven entry point, or the SSH key picker, a screen reader announces nothing. Users cannot tell which command or connection Enter will run, which makes the palette effectively unusable non-visually.

## Recommendation

Give each option a stable id (`${listId}-opt-${index}`) and set aria-activedescendant={results.length ? optionId(activeIndex) : undefined} on the input. In KeyPathInput, add aria-controls pointing at the listbox id and set aria-expanded only when the list is rendered. Give the KeyPathInput validation <p> an id that the caller's aria-describedby includes, and role="status". Add RTL tests asserting that aria-activedescendant follows ArrowDown.

## Verification

Confirmed. CommandPalette hard-codes aria-expanded, and neither widget sets aria-activedescendant or gives its options ids. KeyPathInput has no aria-controls, and its validation <p> has no id or role.
