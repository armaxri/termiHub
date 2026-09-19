---
id: UISF-011
title: react-hook-form + zod used in exactly one form; every other editor hand-rolls useState + manual validation
angle: ui-shared-foundation
severity: high
category: arch
is_workaround: false
subsystem: src/components/DynamicForm
evidence:
  - src/components/DynamicForm/ConnectionSettingsForm.tsx:2
  - src/components/ConnectionEditor/ConnectionEditor.tsx:312
  - src/components/ConnectionEditor/ConnectionEditor.tsx:493
  - src/components/TunnelEditor/TunnelEditor.tsx:96
  - src/components/WorkflowSidebar/WorkflowEditorDialog.tsx:89
  - src/components/MacroSidebar/MacroEditorDialog.tsx:56
  - src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:53
  - src/components/ThemeEditor/ThemeEditor.tsx:39
  - src/components/Settings/CustomRuleEditor.tsx:91
status: partial
resolution: "#3074-3082 — RHF+zod editor migration, one-PR-per-editor. 7/8 editors FULLY migrated: CustomRuleEditor #3074, EmbeddedServerDialog #3075, MacroEditorDialog #3076, WorkflowEditorDialog #3077, ThemeEditor #3079, TunnelEditor #3080 (+ConnectionSettingsForm was already RHF). ConnectionEditor #3082 = top-level fields migrated (name w/ cross-namespace uniqueness superRefine, sourceFile, persistent); its connection-TYPE selector + icon/terminalOptions/agentSettings deliberately KEPT LOCAL (type-selector has ~40 derived effects + zero validation benefit; high-risk on core connect flow) → tracked #3081. Substantive intent achieved; remainder intentional-keep-local. Each: superRefine 1:1 validation, synchronous safeParse Save-gate, shared ui primitives"
---

## What

The repo's UI design system states forms are `react-hook-form` + `zod` (`.claude/CLAUDE.md` →
"Field → react-hook-form + zod"). In practice **`ConnectionSettingsForm.tsx` is the only file under
`src/components` that uses `useForm`/`zodResolver`** (ConnectionSettingsForm.tsx:2-3,54-58). Every
other editor hand-rolls `useState`-per-field plus a manual `canSave`/error derivation:

- `ConnectionEditor.tsx:312-430` — a wall of `useState`; manual dirty-tracking via refs + `JSON.stringify`
  (`:453-488`); hand-rolled name-uniqueness `useMemo` (`:493-531`); hand-rolled `canSave` (`:545`).
- `TunnelEditor.tsx:96-107` — 7 `useState` fields; validation in a separate hand-rolled module
  `tunnelValidation.ts` instead of a zod schema (`:146-147`).
- `WorkflowEditorDialog.tsx:89-93` / `MacroEditorDialog.tsx:56-59` / `EmbeddedServerDialog.tsx:53` /
  `ThemeEditor.tsx:39` / `CustomRuleEditor.tsx:91` — `useState` blobs + manual `canSave`.

The same "required / unique name" validation is re-implemented three different ways:
`ThemeEditor.tsx:60`, `CustomRuleEditor.tsx:103`, `ConnectionEditor.tsx:493-519` — each an ad-hoc
`x.trim() === "" ? "…required" : undefined`.

## Why it matters

Form state + validation is the highest-frequency logic in the editor cluster, and there is no shared
approach: the design system prescribes RHF+zod, one form follows it, and ~8 others each hand-roll
state, dirty-tracking, and validation. This is double-maintenance and a correctness risk (dirty
detection via `JSON.stringify`, ad-hoc required checks, validity flags that can desync from the
field values) — exactly the class of bug a schema + resolver removes. It also makes `ui/Field`'s
`error` slot underused because validation isn't produced in a shared shape.

## Evidence

- Only RHF/zod consumer: `DynamicForm/ConnectionSettingsForm.tsx:2-3,54-58,204-235`.
- Hand-rolled editors: frontmatter (each cited useState/canSave line).
- Duplicated required-name validation: `ThemeEditor.tsx:60`, `CustomRuleEditor.tsx:103`,
  `ConnectionEditor.tsx:493-519`.

## Recommendation

Standardise editors on `react-hook-form` + `zod` (already dependencies) with a small shared
`useEditorForm` wrapper that wires `zodResolver`, dirty-tracking, and a `canSave` derived from form
validity — then feed field errors through `ui/Field`. Migrate TunnelEditor's `tunnelValidation.ts`
into a zod schema. This collapses the per-editor useState/validation boilerplate and unifies dirty
detection.
