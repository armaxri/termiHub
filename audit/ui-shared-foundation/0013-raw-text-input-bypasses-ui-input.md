---
id: UISF-013
title: Raw <input type="text"> bypasses ui/Input across editors, settings, and pickers
angle: ui-shared-foundation
severity: medium
category: ui
is_workaround: false
subsystem: src/components/ui/Input
evidence:
  - src/components/WorkspaceEditor/ConnectionPicker.tsx:86
  - src/components/Settings/GeneralSettings.tsx:106
  - src/components/Settings/AppearanceSettings.tsx:298
  - src/components/Settings/SerialPortSettings.tsx:141
  - src/components/Settings/KeyPathInput.tsx:145
  - src/components/Settings/FileTypeSettings.tsx:151
  - src/components/Settings/CustomGrammarsSettings.tsx:213
  - src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:252
status: open
---

## What

`ui/Input` is the shared token'd text input, but ~20 raw `<input type="text">` (and search inputs)
remain across the app, each re-styling its own wrapper class instead of composing `Input`:

- `WorkspaceEditor/ConnectionPicker.tsx:86` — `connection-picker__search`.
- `Settings/GeneralSettings.tsx:106` — "Default User" (inside a SettingsField, so should just be `Input`).
- `Settings/AppearanceSettings.tsx:298` — "Font Family".
- `Settings/SerialPortSettings.tsx:141` — add-prefix field (`settings-panel__create-input`).
- `Settings/KeyPathInput.tsx:145` — `role="combobox"` with a hand-rolled dropdown/listbox (also
  re-implements type-ahead keyboard logic that Radix `Select` provides).
- `Settings/FileTypeSettings.tsx:151,165`, `CustomGrammarsSettings.tsx:213,223`,
  `ExternalFilesSettings.tsx:152`, `KeyboardSettings.tsx:160`, `SettingsSearch.tsx:31`,
  `PortableModeSettings.tsx:66`, `LanguagePackagesSettings.tsx:161`.
- `EmbeddedServerDialog.tsx:252,261,271,287,297` (text/number fields hand-rolled).

## Why it matters

The raw inputs miss `Input`'s token'd focus ring, error state, sizing, and (for the search boxes) any
shared magnifier/clear affordance. They each carry a per-component input class, so the app's most
basic control renders a dozen slightly-different ways. `KeyPathInput`'s hand-rolled combobox is the
worst: it duplicates dropdown + keyboard-nav logic that the shared `Select` (Radix) already solves.

## Evidence

See frontmatter. Grep of `<input` across `src/components` (excluding `ui/` and tests) returns 44
matches; after removing radio/checkbox (UISF-009) and color inputs (UISF-016), the remainder are
text/search inputs that should compose `ui/Input`.

## Recommendation

Migrate the raw text inputs to `ui/Input`. For the search boxes, use the `SearchInput` primitive
proposed in UISF-004. Rebuild `KeyPathInput` as a Radix combobox (or a `Select` with a filterable
option list) instead of a bespoke `role="combobox"` input + hand-rolled listbox.
