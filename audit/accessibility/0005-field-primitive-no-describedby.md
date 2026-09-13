---
id: A11Y-005
title: Field primitive does not wire aria-describedby / aria-invalid onto its control
angle: accessibility
severity: medium
category: a11y
is_workaround: false
subsystem: src/components/ui/Field
evidence:
  - src/components/ui/Field.tsx:42
  - src/components/ui/Field.tsx:51
status: fixed
resolution: "#2735 — Field primitive fix cascaded to ~94 form fields"
---

## What

The shared `Field` primitive gets most of the accessibility right — it renders a real
`<label htmlFor>` and an error node with `id={`${htmlFor}-error`}` and `role="alert"` — but it does
**not** connect that error to the control. It renders `children` untouched between the label and the
message, so the wrapped `Input`/`Select` gets **no `aria-describedby`** pointing at the error and
**no `aria-invalid`** unless the *caller* remembers to add both.

`Field` is used ~94 times across the app; a grep for `aria-describedby` / `aria-invalid` in
`src/components` finds only ~2–4 call sites. So for the overwhelming majority of fields, when an
error is present a screen-reader user who focuses the input is not told there's an error associated
with it, and the field is not marked invalid. (The `role="alert"` does fire once when the message
first appears — good — but the *persistent* programmatic association and invalid state are missing.)

## Why it matters

- **WCAG 1.3.1 Info and Relationships (A)** — the error's relationship to the field isn't
  programmatically determinable.
- **WCAG 3.3.1 Error Identification (A)** — partially met (role=alert announces once) but the
  field↔error link is absent, so re-navigating to the field re-hears nothing.
- **WCAG 4.1.2 Name, Role, Value (A)** — the invalid state isn't exposed.

This is the highest-leverage single fix in the audit: correcting the primitive fixes ~94 fields at
once (and is the clean way to resolve A11Y-002 for DynamicForm too, once DynamicForm adopts Field).

## Evidence

`src/components/ui/Field.tsx`:

```tsx
const errorId = `${htmlFor}-error`;
return (
  <div className={classes} {...rest}>
    <label className="ui-field__label" htmlFor={htmlFor}>{label}</label>
    {children}                                   // ← control rendered as-is; no describedby/invalid injected
    {error ? <span … id={errorId} role="alert">…{error}</span> : null}
  </div>
);
```

## Recommendation

- Have `Field` inject `aria-describedby={error ? errorId : undefined}` and
  `aria-invalid={error ? true : undefined}` onto its single control child (e.g. via
  `React.cloneElement`, merging with any describedby the child already has), or expose a small
  render-prop / `describedById` so callers wire it uniformly.
- The `Input` primitive already emits `aria-invalid` from its `error` prop — have `Field` pass
  `error` through, or standardize on one mechanism.
- Test: a `Field` with an `error` produces a control whose accessible description is the message and
  whose `aria-invalid` is true.
