---
id: A11Y-001
title: Connection-form inputs have no programmatic label (span, not label htmlFor)
angle: accessibility
severity: high
category: a11y
is_workaround: false
subsystem: src/components/DynamicForm
evidence:
  - src/components/DynamicForm/DynamicField.tsx:155
  - src/components/DynamicForm/DynamicField.tsx:169
  - src/components/DynamicForm/DynamicField.tsx:186
  - src/components/DynamicForm/DynamicField.tsx:200
status: fixed
resolution: "#2735"
---

## What

`DynamicForm` renders every schema-driven connection-config form (SSH, serial, telnet, Docker,
agent, embedded servers, all network/tunnel settings). Its field label is a bare `<span
className="settings-form__label">` — **not** a `<label htmlFor>` — and the text/number/password
inputs it wraps carry **no `id` and no `aria-label`**. There is therefore no programmatic
association between the visible label and the control.

- `FieldLabel` → `<span className="settings-form__label">{field.label}…</span>` (line 155).
- `TextField` → `<Input … aria-required={…} />` with **no** `aria-label`, no `id` (line 169).
- `NumberField`, `PasswordField` — same (no name; `PasswordField` doesn't even set `aria-required`).

Screen readers announce these as an unnamed "edit text" / "edit password". The visible "Host",
"Port", "Username" text sits in an adjacent span the AT never connects to the field.

(`BooleanField` (Toggle) and `SelectField` DO pass `aria-label={field.label}`, so those two types
are named — the gap is specifically the free-text/number/password inputs, i.e. most of a
connection form.)

## Why it matters

This is the app's **primary task**: to use termiHub a user must open and configure a connection.
A blind user tabbing through an SSH form hears "edit text, edit text, edit text" with no way to
know which is host, port, or username. Placeholder text is not a substitute — it is not a reliable
accessible name (it disappears on input and many AT configs ignore it). This fails three
Level-A criteria at once:

- **WCAG 1.3.1 Info and Relationships (A)** — the label/field relationship isn't programmatically
  determinable.
- **WCAG 3.3.2 Labels or Instructions (A)** — no label is provided to AT.
- **WCAG 4.1.2 Name, Role, Value (A)** — the control has a role but no accessible name.

## Evidence

`src/components/DynamicForm/DynamicField.tsx`:

```tsx
function FieldLabel({ field }: { field: SettingsField }) {
  return (
    <span className="settings-form__label">   // ← span, no htmlFor
      {field.label}
      {field.required && <span className="settings-form__required" aria-hidden="true"> *</span>}
    </span>
  );
}

function TextField(...) {
  return (
    <>
      <FieldLabel field={field} />
      <Input type="text" … aria-required={field.required || undefined} … />  // ← no id, no aria-label
    </>
  );
}
```

Contrast with the shared `Field` primitive (`src/components/ui/Field.tsx`), which does it right
(`<label htmlFor>` + `id`), but which `DynamicForm` does not use.

## Recommendation

Give every field a stable `id` (e.g. `field-${field.key}`) and associate it:

- Make `FieldLabel` a real `<label htmlFor={id}>` (or route the whole thing through the shared
  `Field` primitive, which already wires `htmlFor`, the error id, and `role="alert"`).
- Pass that `id` to `Input`/`NumberInput`/`PasswordInput`. As a minimum stopgap, pass
  `aria-label={field.label}` to the text/number/password inputs exactly as `SelectField`/
  `BooleanField` already do — but a visible `<label>` association is the correct fix and also
  enlarges the click target (2.5.8).
- Add a regression test asserting `getByLabelText(field.label)` resolves each input.
