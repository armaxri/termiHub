---
id: WA-FE-002
title: User-facing agent "Allow self-update" toggle persists a preference for an unimplemented feature
angle: workaround-frontend
severity: high
category: workaround
is_workaround: true
subsystem: components/DynamicForm
evidence:
  - src/components/DynamicForm/agentSchema.ts:110
  - src/components/DynamicForm/agentSchema.ts:116
  - src/types/terminal.ts:301
  - src/components/DynamicForm/agentSchema.ts:104
status: open
---

## What
The agent connection form exposes an **"Allow agent self-update"** boolean and an
**Update strategy** picker whose own description admits the underlying mechanism does not
exist yet:

```ts
// agentSchema.ts
key: "allowSelfUpdate",
label: "Allow agent self-update",
description:
  "Let the agent check GitHub and update itself in the background. Opt-in; the " +
  "self-update mechanism is not yet implemented, so this only persists the preference.",
```

The type declaration says the same (`src/types/terminal.ts:301`): *"The self-update mechanism
(SI-8) is not yet implemented — this persists the preference until it lands."* The
`updateStrategy` field similarly ships a **"Deferred"** option that is "saved and takes effect
once it lands" (`agentSchema.ts:104-108`).

## Why it matters
- These are real, always-visible controls in the connection editor that **do nothing**. A user
  enabling "Allow self-update" reasonably believes their agents will self-update; they will not.
  For a safety-critical tool, a control that silently no-ops is a trust/correctness defect, not
  just polish.
- Shipping settings ahead of the feature they gate is a classic stopgap: the UI was built before
  the backend and left wired to a persisted-but-inert preference.

## Evidence
- `src/components/DynamicForm/agentSchema.ts:110-119` — the rendered field + self-describing
  "not yet implemented" text.
- `src/components/DynamicForm/agentSchema.ts:104-108` — "Deferred" strategy that "takes effect
  once it lands".
- `src/types/terminal.ts:299-306` — `allowSelfUpdate?` / `updateStrategy?` documented as
  pending SI-8.

## Recommendation
Either land SI-8 before release, or **hide these controls** (and the "Deferred" strategy option)
behind the same gate that hides other unfinished features until the backend exists — do not ship
a persisted preference the user can toggle with no effect. Keep the schema/type fields if desired
for forward-compat, but omit them from the rendered form until functional. Removing the "not yet
implemented" wording from a shipping description is the signal it is done.
