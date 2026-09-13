---
id: UISF-016
title: Small utility helpers copy-pasted across features (parseTags, slugify, id-gen, formatBytes, errorMessage, color-swatch)
angle: ui-shared-foundation
severity: low
category: arch
is_workaround: false
subsystem: src/utils
evidence:
  - src/components/MacroSidebar/MacroEditorDialog.tsx:32
  - src/components/WorkflowSidebar/WorkflowEditorDialog.tsx:51
  - src/components/MacroSidebar/MacroSidebar.tsx:16
  - src/components/WorkflowSidebar/WorkflowSidebar.tsx:20
  - src/components/EmbeddedServerSidebar/EmbeddedServerItem.tsx:43
  - src/utils/formatters.ts:4
  - src/components/ThemeEditor/ThemeEditor.tsx:137
  - src/components/Settings/CustomRuleEditor.tsx:179
status: open
---

## What

Several small display/logic helpers are copy-pasted between sibling features instead of living in
`src/utils`:

- **`parseTags`** — byte-identical in `MacroEditorDialog.tsx:32-43` and `WorkflowEditorDialog.tsx:51-62`.
- **`slugify*`** — `MacroSidebar.tsx:25-31` `slugifyMacroName` ≡ `WorkflowSidebar.tsx:29-35` `slugifyWorkflowName`.
- **ID generation** — `MacroSidebar.tsx:16-22` `generateMacroId()` ≡ `WorkflowSidebar.tsx:20-26`
  `generateWorkflowId()` (same `crypto.randomUUID()` + fallback), while `EmbeddedServerSidebar.tsx:76`
  and `TunnelSidebar.tsx:55` inline a *different* ad-hoc scheme (`` `srv-${Date.now()}-…` ``) — two
  competing id conventions.
- **`formatBytes`** — `EmbeddedServerItem.tsx:43-47` defines a local copy even though
  `utils/formatters.ts:4` exports one (which `TunnelListItem.tsx:20` correctly imports).
- **`errorMessage(err)`** — `EmbeddedServerItem.tsx:37-41` re-implements the
  `err instanceof Error ? err.message : String(err)` unwrap that is inlined in nearly every sidebar's
  catch blocks (`TunnelSidebar.tsx:63`, `MacroSidebar.tsx:101`, `WorkspaceSidebar.tsx:78`, …).
- **Color swatch + hex input** — `ThemeEditor.tsx:137-154` and `CustomRuleEditor.tsx:179-197` both
  hand-roll `<input type="color">` + adjacent hex `Input`; no shared `ColorInput` primitive.

## Why it matters

Each duplicate is a place a fix or format change must be made twice (and a `formatBytes` that already
diverges from the shared one). Small individually, but collectively they show the "shared utils"
layer is under-used: pure helpers that clearly belong in `src/utils` are re-authored per feature.

## Evidence

See frontmatter for exact sites.

## Recommendation

Move `parseTags`, `slugify`, `generateId`, and `errorMessage` into `src/utils` and import them;
standardise on one id scheme. Delete the local `formatBytes` in `EmbeddedServerItem` in favour of
`utils/formatters.ts`. Add a `ColorInput` primitive to `src/components/ui/` for the swatch+hex pair.
