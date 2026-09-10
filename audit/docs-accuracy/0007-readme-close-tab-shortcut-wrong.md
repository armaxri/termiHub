---
id: DOC-007
title: README keyboard-shortcut table says Ctrl+W = Close Tab, contradicting the code default (Ctrl+Shift+W) and keyboard-shortcuts.md
angle: docs-accuracy
severity: medium
category: docs
is_workaround: false
subsystem: README/keyboard-shortcuts
evidence:
  - README.md:226
  - docs/keyboard-shortcuts.md:34
  - src/services/keybindings.ts:87
  - src/services/keybindings.test.ts:168
status: open
---

## What

The README keyboard-shortcut table lists `Ctrl+W` / `Cmd+W` for "Close active tab". On Windows/Linux
the actual default is **`Ctrl+Shift+W`** — `Ctrl+W` is deliberately *not* bound, because it is
readline `delete-word-backward` and the app passes it through to the shell. The README directly
contradicts the dedicated conflict-avoidance doc (`docs/keyboard-shortcuts.md`) and the code.

## Why it matters

A user who reads the README will press `Ctrl+W` expecting to close a tab and instead send a
word-delete to their local/remote shell. This is exactly the conflict `keyboard-shortcuts.md` was
written to prevent, so the README undoes the safety design in its own quick-reference. (macOS
`Cmd+W` in the README is correct.)

## Evidence

- README.md:226 — `| `Ctrl+W` / `Cmd+W` | Close active tab |`.
- `docs/keyboard-shortcuts.md:34` — Close Tab default (Win/Linux) is `Ctrl+Shift+W`; `Ctrl+W` is in
  the "Was avoided" column ("readline `delete-word-backward`, vim `<C-w>` window prefix").
- Code default: `src/services/keybindings.ts:87` "Avoid Ctrl+W: readline …"; tests confirm
  `src/services/keybindings.test.ts:168` "finds close-tab for Ctrl+Shift+W" and `:173` "does not
  match close-tab for Ctrl+W (readline delete-word passes through)".

## Recommendation

Fix the README row to show `Ctrl+Shift+W` (Win/Linux) / `Cmd+W` (macOS), and consider linking to
`docs/keyboard-shortcuts.md`. Audit the rest of the README table against the code defaults while
there (e.g. sidebar toggle, splits) since the table appears hand-maintained and drift-prone.
