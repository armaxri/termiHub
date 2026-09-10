---
id: FEC-019
title: ConnectionSettingsForm's isResetting ref can swallow a genuine first edit; relies on RHF value-cache workaround
angle: frontend-components
severity: low
category: bug
is_workaround: true
subsystem: src/components/DynamicForm
evidence:
  - src/components/DynamicForm/ConnectionSettingsForm.tsx:143
  - src/components/DynamicForm/ConnectionSettingsForm.tsx:165
status: open
---

## What
On a schema (connection-type) change the form calls `reset({ ...cleared,
...settings })` and sets `isResetting.current = true`. The `watch` subscription
(`:165-174`) is expected to fire once from that reset and consume the flag
(`isResetting.current = false; return;`) so the reset itself is not propagated to
the parent as a user edit. But react-hook-form's `reset` does not guarantee a
`watch` emission when the new values equal the current ones — if the cleared+
settings values match what the form already holds, no `watch` fires, `isResetting`
stays `true`, and the **next genuine user edit** is swallowed (the callback
consumes the flag and returns without calling `onChange`).

The surrounding code (clearing every schema key to `null` to defeat RHF's
per-name value cache, `:130-158`) is itself an explicit workaround for
`shouldUnregister:false` leaking a shared-name field between connection types
(#1820).

## Why it matters
Edge case, but the failure mode is a silently-dropped edit in the connection
editor — the user types a value, it doesn't propagate, and Save persists the old
value. It depends on RHF internals (whether `reset` emits) that can change across
library versions.

## Evidence
`src/components/DynamicForm/ConnectionSettingsForm.tsx:143-174`.

## Recommendation
Don't gate propagation on a "did reset emit?" flag. Compare the incoming
`values` against the last-propagated snapshot and skip only when equal, or clear
`isResetting` deterministically (e.g. in the same tick after `reset`, via
`queueMicrotask`) rather than depending on a watch emission that may not happen.
