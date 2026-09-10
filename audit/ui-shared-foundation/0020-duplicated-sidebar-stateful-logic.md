---
id: UISF-020
title: Sidebar stateful logic copy-pasted — list-filter predicate, import/export flow, and delete-confirm machinery
angle: ui-shared-foundation
severity: medium
category: arch
is_workaround: false
subsystem: src/components
evidence:
  - src/components/MacroSidebar/MacroSidebar.tsx:34
  - src/components/WorkflowSidebar/WorkflowSidebar.tsx:38
  - src/components/RecentSessionsSidebar/RecentSessionsSidebar.tsx:20
  - src/components/MacroSidebar/MacroSidebar.tsx:111
  - src/components/WorkflowSidebar/WorkflowSidebar.tsx:154
  - src/components/WorkspaceSidebar/WorkspaceSidebar.tsx:103
  - src/components/TunnelSidebar/TunnelSidebar.tsx:108
status: open
---

## What

The flat sidebars re-implement the same stateful logic inline rather than sharing hooks:

- **List-filter predicate + `filtered` memo.** `MacroSidebar.tsx:34-39` (`macroMatches`),
  `WorkflowSidebar.tsx:38-43` (`workflowMatches`), `RecentSessionsSidebar.tsx:20-27` (`entryMatches`)
  are the same `name/description/tags .toLowerCase().includes(q)` shape, and the driving memo
  (`MacroSidebar.tsx:61-64`, `WorkflowSidebar.tsx:85-88`, `RecentSessionsSidebar.tsx:52-55`) is the
  same three lines each. None reuse the existing `utils/connectionSearch.ts` / `agentTreeSearch.ts`
  matchers that the tree sidebars use.
- **Export-to-file flow.** `MacroSidebar.tsx:111-127` (`writeMacrosToFile`),
  `WorkflowSidebar.tsx:154-170` (`writeWorkflowsToFile`), `WorkspaceSidebar.tsx:103-119`
  (`handleExport`) are the same `save()` → `writeTextFile()` → `toast` sequence.
- **Import-from-file flow.** `MacroSidebar.tsx:150-167`, `WorkflowSidebar.tsx:193-225`,
  `WorkspaceSidebar.tsx:121-139` — same `open()` → `readTextFile()` → count-toast structure.
- **Delete-confirm machinery.** Every sidebar re-implements `pendingDelete` useState + `handleDelete`
  + `handleConfirmDelete` + a ConfirmDialog: TunnelSidebar.tsx:36,108-115, MacroSidebar.tsx:59,169-189,
  WorkflowSidebar.tsx:83,227-247, WorkspaceSidebar.tsx:30,59-81, EmbeddedServerSidebar.tsx:48,117-141.

## Why it matters

This is business/display logic copy-pasted across features — exactly what shared hooks/utils are for.
Each copy is a place a bug or behaviour change (e.g. a different toast message, an import validation
step) must be repeated, and the import/export and delete-confirm flows touch user data, so drift here
is more than cosmetic.

## Evidence

See frontmatter. Three copies each of the filter predicate, export flow, and import flow; five copies
of the delete-confirm state machine.

## Recommendation

Extract shared hooks: `useListFilter(items, matcher)` (defaulting to a shared matcher, feeding
UISF-004's SearchInput), `useJsonFileExport`/`useJsonFileImport` for the save/read/toast flow, and
`useDeleteConfirm(onDelete)` returning `{pending, request, confirm, cancel, dialogProps}`. Migrate
the flat sidebars onto them.
