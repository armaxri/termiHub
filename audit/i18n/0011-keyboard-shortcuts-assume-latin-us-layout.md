---
id: I18N-011
title: Keyboard shortcut matching assumes a Latin/US layout (event.key, [a-zA-Z])
angle: i18n
severity: medium
category: bug
is_workaround: false
subsystem: src/services/keybindings
evidence:
  - src/services/keybindings.ts:405
  - src/services/keybindings.ts:671
  - src/services/keybindings.ts:679
status: open
---

## What
Shortcut matching compares the produced character `event.key`, not the physical
`event.code`:

```ts
const keyMatches =
  event.key === combo.key || event.key.toLowerCase() === combo.key.toLowerCase();  // :405
```

and the "is this a bindable key" gate hardcodes the Latin alphabet:

```ts
if (event.key.length === 1) {
  if (/^[a-zA-Z]$/.test(event.key)) return true;                                    // :671/:679
  if (event.key === "\\" || event.key === "[" || event.key === "]") return true;
}
```

## Why it matters
Bucket A (behavioral, layout-dependent — the keyboard-layout facet of i18n).
`event.key` is the layout-mapped character, so a shortcut stored as a letter
resolves to a **different physical key** on AZERTY / QWERTZ / Dvorak, and to a
**non-Latin character** on Cyrillic, Greek, Arabic, or Hebrew layouts. Two
consequences:

- On non-Latin layouts, `event.key` for letter keys is a non-Latin glyph, so it
  fails the `/^[a-zA-Z]$/` gate — those keys can neither trigger nor be bound to
  shortcuts at all. Users on such layouts effectively lose letter-based
  shortcuts.
- On alternative Latin layouts, shortcuts land on the "wrong" physical key
  relative to where the label suggests (a known cross-app friction, e.g.
  Ctrl+W/Z/Y positions differ between QWERTY and QWERTZ/AZERTY).

(Note: the `.toLowerCase()` here is the locale-independent JS variant, so there
is **no** Turkish-i bug — the issue is purely layout, not case-folding locale.)

## Evidence
`src/services/keybindings.ts:405` (match on `event.key`), `:671`/`:679` (the
`[a-zA-Z]` bindability gate).

## Recommendation
For layout-independent shortcuts, match on `event.code` (physical position,
e.g. `KeyW`) rather than `event.key`, or offer both a "by character" and "by
physical key" mode as VS Code does. At minimum, broaden the bindability gate so
non-Latin single characters are bindable (use `event.key.length === 1 &&
!isModifier` or Unicode letter categories instead of `[a-zA-Z]`), so non-Latin
layouts aren't locked out of letter shortcuts. Verify with an AZERTY and a
Cyrillic layout.
