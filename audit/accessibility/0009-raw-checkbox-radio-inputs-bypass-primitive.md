---
id: A11Y-009
title: Raw native checkbox/radio inputs bypass the shared Checkbox primitive across ~10 dialogs
angle: accessibility
severity: low
category: a11y
is_workaround: false
subsystem: src/components (multiple dialogs)
evidence:
  - src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:189
  - src/components/Sidebar/AgentSetupDialog.tsx:424
  - src/components/Settings/CustomizeLayoutDialog.tsx:174
  - src/components/ConnectionEditor/JumpHostSection.tsx:109
status: open
---

## What

24 raw `<input type="checkbox">` / `<input type="radio">` elements appear across ~10 dialogs
(EmbeddedServerDialog, AgentSetupDialog, CustomizeLayoutDialog, PortableModeSettings,
SaveWorkspaceDialog, PasswordPrompt, OpenSavedFileDialog, JumpHostSection, ExportDialog,
SpawnPicker), instead of the shared `Checkbox` (Radix) primitive.

**Accessibility-wise these are mostly fine**: in every case checked, the input is wrapped in a
`<label>` (implicit association), so it has an accessible name and real native
checkbox/radio semantics and keyboard behavior — often *more* robust than a custom control. Native
inputs also pick up the global `input:focus` ring from `global.css`.

The issue is **consistency**, which has a minor a11y dimension:

- Focus-ring and sizing differ from the tokened primitive (the primitive uses `--shadow-focus`;
  native inputs get the browser default or the global `input:focus` box-shadow), so focus
  affordance is not uniform.
- Radio *groups* rely on shared `name=` attributes rather than a `role="radiogroup"` wrapper with a
  group label — acceptable natively, but `fieldset`/`legend` or `radiogroup` labeling is
  inconsistent across these dialogs.

## Why it matters

Primarily a design-system consistency finding (owned in depth by the `ui-shared-foundation`
angle). The a11y impact is low: these controls are operable and named. Flagged here so the
consistency fix also standardizes focus-ring and group labeling.

- **WCAG 1.4.11 Non-text Contrast (AA)** — only insofar as the native focus ring may be weaker than
  intended on custom-styled inputs; verify per control.

## Evidence

Representative sites (all wrap the input in a `<label>`):

- `src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:189` (radio),
  `:253/:262/:272` (checkboxes) — inside `<fieldset><legend>` groups (good).
- `src/components/Sidebar/AgentSetupDialog.tsx:424/443/472` (radios), `:520` (checkbox).
- `src/components/ConnectionEditor/JumpHostSection.tsx:109` (checkbox).

Full list: `grep -rn 'type="\(checkbox\|radio\)"' src/components` → 24 hits across 10 files.

## Recommendation

- Migrate to the shared `Checkbox` primitive (and add a `RadioGroup` primitive if one is missing —
  Radix `react-radio-group` is already a natural fit) so focus-ring, size, and disabled styling are
  uniform and tokened.
- Where native inputs are kept, ensure each radio set is wrapped in a `fieldset`/`legend` (or
  `role="radiogroup"` + `aria-labelledby`) and verify the focus ring meets 1.4.11 (≥3:1).
- Low priority; batch with the `ui-shared-foundation` consolidation.
