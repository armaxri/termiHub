---
id: UX-025
title: Agent "Deferred" update strategy is selectable but inert; three sources disagree on what works
angle: ux-flows
severity: medium
category: workaround
is_workaround: true
subsystem: src/components/DynamicForm
evidence:
  - src/components/DynamicForm/agentSchema.ts:92
  - src/types/terminal.ts:280
  - src/components/AgentUpdateBanner/AgentUpdateBanner.tsx:62
status: open
---

## What
The agent "Update Strategy" select offers Immediate / Coordinated / **Deferred (apply on last
disconnect)** (`agentSchema.ts:92-109`). Its description says "Immediate and Coordinated are active …
Deferred is saved and takes effect once it lands" — so "Deferred" is a normal-looking, selectable
option that does not behave as labeled. Worse, three sources disagree on what actually works:
- `terminal.ts:280-282`: "Only `immediate` … is honored today; `coordinated` … and `deferred` …
  persist the preference until those subsystems land."
- `agentSchema.ts:104-108`: Immediate **and** Coordinated are active.
- `AgentUpdateBanner.tsx:62-79`: the Coordinated path *is* implemented.

## Why it matters
A user can pick a strategy that silently won't behave as its label promises, and the app's own
sources can't agree on which strategies are live — so any UX copy derived from them is untrustworthy.
This is an inert option presented as functional (workaround-mandate territory) plus a documentation-
correctness defect.

## Evidence
- `agentSchema.ts:92-109` — Deferred selectable; description hedges.
- `terminal.ts:280-282` vs `agentSchema.ts:104-108` vs `AgentUpdateBanner.tsx:62-79` — three-way
  disagreement on which strategies are honored.

## Recommendation
Reconcile the three sources to one source of truth about which strategies are live. Remove or
disable "Deferred" (and label it "coming soon") until it is honored, and correct the stale
`terminal.ts` comment about Coordinated.
