---
id: A11Y2-001
title: "Keyboard shortcut rebinding is mouse-only (binding cell is a click-only <td>)"
angle: accessibility
severity: medium
category: keyboard
is_workaround: false
subsystem: "src/components/Settings/KeyboardSettings"
evidence:
  - src/components/Settings/KeyboardSettings.tsx:455-468
  - src/components/Settings/KeyboardSettings.tsx:465
  - src/components/Settings/KeyboardSettings.tsx:475-499
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

In Settings > Keyboard, the only way to start recording a new shortcut is the onClick on a plain <td className="keyboard-settings__binding-cell">. The cell has no tabIndex, no role="button" and no key handler. The keyboard-reachable buttons in the row are only Unbind and Reset to default. The recording state ('Press a key combination…') is also not in a live region, so a screen-reader user is not told that capture has started.

## Why it matters

WCAG 2.1.1 Keyboard (A). A keyboard-only user cannot rebind any shortcut, including shortcuts that clash with their assistive technology. Customizing shortcuts is itself an accessibility feature (2.1.4), so locking it behind a mouse is a real barrier.

## Recommendation

Render the binding display as a <button> (or the shared Button primitive) with aria-label={`Change shortcut for ${binding.label}, currently ${displayStr || 'unbound'}`} and onClick={onStartRecording}. Wrap the recording prompt in role="status" aria-live="polite". Move focus back to the button after recording finishes or is cancelled. Add an RTL test that activates recording with Enter.

## Verification

Confirmed. KeyboardSettings.tsx:456-473: the binding <td> has only onClick, with no tabIndex, role or key handler. The row's only buttons are Unbind and Reset, and the recording prompt is plain text with no live region.
