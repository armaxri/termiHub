---
id: UISF-012
title: Three competing field-wrapper conventions (ui/Field vs Settings/SettingsField vs raw settings-form__field)
angle: ui-shared-foundation
severity: medium
category: ui
is_workaround: false
subsystem: src/components/ui/Field
evidence:
  - src/components/ui/Field.tsx
  - src/components/Settings/SettingsField.tsx
  - src/components/ConnectionEditor/ConnectionEditor.tsx:1156
  - src/components/ConnectionEditor/ConnectionTerminalSettings.tsx:231
  - src/components/ConnectionEditor/JumpHostEntry.tsx:53
  - src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:172
status: open
---

## What

There are three parallel ways to render "label + control + error/hint" in the app:

1. **`ui/Field`** (Field.tsx) — the shared primitive: label + `htmlFor` + inline `error` with
   `role="alert"`. Used correctly by TunnelEditor, WorkspaceEditor, Workflow/Macro editors,
   ThemeEditor, CustomRuleEditor, WorkflowStepRow.
2. **`Settings/SettingsField`** (SettingsField.tsx) — a *second* field wrapper: label + hint,
   auto-derives `aria-label`, but **has no error slot**. Used pervasively in Settings panels
   (GeneralSettings 37×, AppearanceSettings 9×).
3. **Raw `settings-form__field` markup** — `<label className="settings-form__field"><span
   className="settings-form__label">…</span>…<p className="settings-form__hint…">error</p></label>`
   hand-written per field.

## Why it matters

Two wrapper components with different capabilities (Field has an error slot, SettingsField does not)
plus a third raw form means field labelling, hint styling, and error rendering are inconsistent, and
any Settings-panel validation error literally cannot be shown through `SettingsField`. The raw
`settings-form__field` blocks are copy-pasted many times:

- `ConnectionEditor.tsx` hand-rolls the label+error block for Name (`:1156-1174`), Type (`:1177`),
  Storage File (`:1224`), and SSH sections (`:1310`, `:1349`) — 5 sites — instead of `<Field error>`.
- `ConnectionTerminalSettings.tsx` repeats the `settings-form__label` block **11×** (`:231,242,254,271,291,315,338,351,372,393`).
- `JumpHostEntry.tsx` repeats it **9×** (`:53,82,102,113,124,135,147,158,172`).
- `EmbeddedServerDialog.tsx` uses its own bespoke `server-dialog__label` + `<fieldset>/<legend>` system (`:172,184,204,218,234,314,329`).

## Evidence

See frontmatter. `ui/Field.tsx` and `Settings/SettingsField.tsx` are the two divergent wrappers; the
raw `settings-form__field` shape is the third convention, repeated 25+ times across ConnectionEditor,
ConnectionTerminalSettings, and JumpHostEntry.

## Recommendation

Consolidate on one field wrapper: either give `SettingsField` an `error` slot and make it a thin
preset of `ui/Field`, or migrate Settings to `ui/Field`. Replace the raw `settings-form__field`
blocks (especially the 11× in ConnectionTerminalSettings and 9× in JumpHostEntry) with the wrapper so
labels/hints/errors render one way. This is a prerequisite for feeding UISF-011's validation errors
into a shared error slot.
