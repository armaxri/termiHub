---
id: LIBFE2-007
title: "About 350 lines of hand-rolled type-guard validation for workflow/macro import while zod is installed and already used for the same domain"
angle: lib-usage-frontend
severity: info
category: arch
is_workaround: false
subsystem: "src/services/workflowIo, macroIo, keybindingIo"
status: open
resolution: ""
audit: 2026-10
commit: "663465d52"
relation: new
evidence:
  - src/services/workflowIo.ts:147
  - src/services/workflowIo.ts:185
  - src/services/workflowIo.ts:515
  - src/services/macroIo.ts:112
  - src/components/WorkflowSidebar/WorkflowEditorDialog.tsx:4
  - src/components/WorkflowSidebar/workflowStepPolicySchema.ts:1
---

## What

Importing untrusted workflow, macro and keybinding files goes through hand-written `typeof`/`isRecord` validators: validateStep, validateStepBody, validateCondition, validateTrigger, validateParameter and others. Today they cover every WorkflowStep field. The editor already validates the same shapes with zod (WorkflowEditorDialog, workflowStepPolicySchema). The exhaustive `switch` catches a new step kind at compile time, but a new optional field on an existing kind compiles cleanly and is silently dropped on import.

## Why it matters

Two parallel validators for one model can drift, and that drift shows up as silent loss of a field on import/export round-trips. Not a defect today; recorded so the next model change considers using one schema.

## Recommendation

When the workflow model next changes, express the import envelope as a zod schema shared with the editor (`z.discriminatedUnion("kind", …)`, typed `satisfies z.ZodType<WorkflowStep>`), keep the human-readable error mapping, and delete the hand-written guards. No new dependency is needed.

## Verification

Confirmed. workflowIo.ts has hand-written isRecord/validateStep/validateTrigger/validateParameter guards, while WorkflowEditorDialog and workflowStepPolicySchema use zod for the same model. This is a drift risk only, with no current defect, so info is correct.
