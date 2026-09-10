---
id: UX-024
title: "Allow agent self-update" toggle is a no-op shipped for an unimplemented feature
angle: ux-flows
severity: medium
category: workaround
is_workaround: true
subsystem: src/components/DynamicForm
evidence:
  - src/components/DynamicForm/agentSchema.ts:110
  - src/types/terminal.ts:299
status: open
---

## What
The agent editor's "Updates" group renders a boolean toggle **"Allow agent self-update"**
(`agentSchema.ts:110-119`) whose own description ends: "the self-update mechanism is not yet
implemented, so this only persists the preference." The type comment confirms it
(`terminal.ts:299-304`: `allowSelfUpdate` — "The self-update mechanism (SI-8) is not yet
implemented — this persists the preference until it lands"). So the control does nothing but store a
boolean.

## Why it matters
A shipped, interactive control that admits in its own help text that it does nothing invites the
user to enable it and expect background updates that never happen. This is the "feature flag / dead
control for unfinished work" pattern the workaround mandate targets — it should not ship in a
release build in a state that misrepresents capability. Corroborates workaround-frontend WA-FE-002.

## Evidence
- `agentSchema.ts:110-119` — toggle + "not yet implemented" description.
- `terminal.ts:299-304` — type comment confirming it only persists the preference.

## Recommendation
Remove the toggle (and the "Deferred" strategy, UX-025) from the shipped agent editor until the
self-update subsystem lands, or gate it behind the experimental flag with an explicit "not yet
active" state. Do not present an inert control as a working setting.
