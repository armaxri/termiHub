---
id: UX-009
title: Field help_text only renders for boolean fields; invisible on text/number/keyvalue fields
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/DynamicForm
evidence:
  - src/components/DynamicForm/DynamicField.tsx:229
  - src/components/DynamicForm/DynamicField.tsx:65
  - core/src/backends/ssh/mod.rs:429
status: fixed
resolution: "#2824 — helpText now surfaced on all field types via shared FieldHelp on FieldLabel (was boolean-only)"
---

## What
`DynamicField.tsx` renders a field's `helpText` (the "?" help button + modal) **only** inside
`BooleanField` (`DynamicField.tsx:229-262`). Text, Number, Password and KeyValueList fields render
only `field.description` (`DynamicField.tsx:65`), never `helpText`. So carefully authored guidance
for exactly the non-obvious non-boolean fields never appears: `connectTimeoutSecs`
(`ssh/mod.rs:429-435`), `env` (`mod.rs:453-460`), and `onReconnectCommand` (`mod.rs:526-534`) all
have help text the user never sees, while only the boolean fields (savePassword, shellIntegration,
resilientReconnect) surface theirs.

## Why it matters
The backend clearly authored help for the fields most in need of explanation (timeout semantics,
AcceptEnv caveats, reconnect-command behavior), but the UI drops all of it for non-boolean field
types. Users get zero guidance on the trickiest inputs.

## Evidence
- `DynamicField.tsx:229-262` — help button/modal rendered only in `BooleanField`.
- `DynamicField.tsx:57-65` — text/number/etc. render `description` only, not `helpText`.
- `ssh/mod.rs:429,453,526` — non-boolean fields with unused `help_text`.

## Recommendation
Render `helpText` uniformly for all field types (a shared "?" affordance on the field label in
`DynamicField`), not just booleans. This is a small change that surfaces guidance the schema
already provides.
