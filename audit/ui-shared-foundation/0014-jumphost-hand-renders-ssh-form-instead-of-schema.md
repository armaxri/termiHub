---
id: UISF-014
title: JumpHostEntry hand-renders a full SSH sub-connection form instead of the schema-driven DynamicForm
angle: ui-shared-foundation
severity: high
category: arch
is_workaround: false
subsystem: src/components/ConnectionEditor
evidence:
  - src/components/ConnectionEditor/JumpHostEntry.tsx:100
  - src/components/ConnectionEditor/JumpHostEntry.tsx:19
  - src/components/ConnectionEditor/JumpHostEntry.tsx:146
  - src/components/DynamicForm/DynamicField.tsx
status: open
---

## What

`.claude/CLAUDE.md` is explicit: "Schema-driven connection forms: connection types declare config as
JSON schemas; `DynamicForm` renders them automatically — **never hardcode connection UI fields**."
`JumpHostEntry.tsx` violates this directly: it hand-renders a complete SSH sub-connection form —
Host (`:104`), Port (`:115`), Username (`:126`), Auth Method (`:137`, with a locally re-declared
`AUTH_OPTIONS` at `:19-23`), Key Path (`:149`), Password (`:161`) — duplicating the exact fields the
SSH connection schema already defines and that `DynamicForm`/`DynamicField` would render. The
auth-method→conditional-field logic (`hop.authMethod === "key"` / `"password"` at `:146,158`)
re-implements the schema's `visibleWhen` behaviour by hand.

## Why it matters

This is the schema-driven-form architecture bypassed on the very feature it is meant to serve (SSH
connection config). Any change to the SSH schema — a new auth method, a renamed field, a new
validation rule — updates the main connection form automatically but silently skips the jump-host
form, so the two drift. It also re-declares `AUTH_OPTIONS` locally, so the auth-method list can
diverge from the canonical one. This is both duplication and a correctness/consistency hazard on a
security-relevant path (jump-host auth).

## Evidence

- `JumpHostEntry.tsx:100-168` hand-renders Host/Port/Username/AuthMethod/KeyPath/Password.
- `JumpHostEntry.tsx:19-23` — local `AUTH_OPTIONS` duplicate.
- `JumpHostEntry.tsx:146,158` — hand-rolled `visibleWhen` for key vs password.
- Canonical renderer: `DynamicForm/DynamicField.tsx` (composes Input/PasswordInput/NumberInput/Select
  per schema field type).

## Recommendation

Render the jump-host hop through the schema-driven `DynamicForm`/`ConnectionSettingsForm` against the
SSH connection schema (or a "ssh-hop" subset of it), so its fields, auth-method options, and
conditional visibility come from the same schema as the primary connection form. Delete the local
`AUTH_OPTIONS` and the hand-rolled field/label markup.
