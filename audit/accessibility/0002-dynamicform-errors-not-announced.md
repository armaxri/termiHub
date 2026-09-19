---
id: A11Y-002
title: Connection-form validation errors are not announced or associated with their field
angle: accessibility
severity: high
category: a11y
is_workaround: false
subsystem: src/components/DynamicForm
evidence:
  - src/components/DynamicForm/DynamicField.tsx:57
  - src/components/DynamicForm/ConnectionSettingsForm.tsx:268
status: fixed
resolution: "#2735"
---

## What

When a connection-config field fails validation, `DynamicField` renders the message as a plain
paragraph:

```tsx
{error && (
  <p className="settings-form__hint settings-form__hint--error"
     data-testid={`field-${field.key}-error`}>
    {error}
  </p>
)}
```

There is **no `role="alert"`/`aria-live`** on the message, **no `id`** on it, and the input has
**no `aria-describedby`** pointing at it and **no `aria-invalid`** state (the `Input` primitive
only sets `aria-invalid` when passed `error`, which `DynamicField` does not do). So:

- The error is not announced when it appears (no live region).
- Focusing the offending field does not read the error (no `aria-describedby`).
- The field is not exposed as invalid (no `aria-invalid`).

The form's Save button is gated on `onValidityChange` (`ConnectionSettingsForm.tsx:268` passes the
error down), so a screen-reader user experiences "Save is disabled and nothing tells me why."

## Why it matters

Combined with A11Y-001 (unlabeled fields), a blind user cannot tell *which* field is wrong or
*what* is wrong. This fails:

- **WCAG 3.3.1 Error Identification (A)** — the error is not programmatically associated with the
  field and is not conveyed to AT.
- **WCAG 4.1.2 Name, Role, Value (A)** — the invalid state (`aria-invalid`) is not exposed.
- Relates to **3.3.3 Error Suggestion (AA)** for the message content.

## Evidence

- `src/components/DynamicForm/DynamicField.tsx:57` — error `<p>` with no role/id/live-region.
- `src/components/DynamicForm/DynamicField.tsx:169` — `TextField` renders `<Input>` without the
  `error` prop, so `aria-invalid` is never set, and without `aria-describedby`.
- Compare the shared `Field` primitive (`src/components/ui/Field.tsx:52`) which renders the error
  with `id={errorId}` and `role="alert"` — the correct pattern DynamicForm doesn't reuse.

## Recommendation

- Give the error node an id (`${id}-error`) and `role="alert"` (or wrap the field in an
  `aria-live="polite"` region).
- On the input, set `aria-describedby={hasError ? errorId : undefined}` and pass `error={!!error}`
  to the `Input` primitive so it emits `aria-invalid`.
- Simplest durable fix: route DynamicField through the shared `Field` primitive and complete
  A11Y-005 (make `Field` propagate `aria-describedby`/`aria-invalid` to its child) so both this and
  every other form benefit.
- Regression test: rendering a field with an error exposes `aria-invalid` and the input's
  accessible description equals the message.
