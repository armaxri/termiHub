---
id: UISF-018
title: EmbeddedServerSidebar is the lone flat sidebar with no keyboard navigation (bypasses useFlatRovingNav)
angle: ui-shared-foundation
severity: medium
category: ui
is_workaround: false
subsystem: src/components/EmbeddedServerSidebar
evidence:
  - src/components/EmbeddedServerSidebar/EmbeddedServerSidebar.tsx:163
  - src/components/EmbeddedServerSidebar/EmbeddedServerItem.tsx:20
  - src/hooks/useFlatRovingNav.ts
status: open
---

## What

Every flat management sidebar drives keyboard navigation through the shared `useFlatRovingNav` hook
(TunnelSidebar.tsx:127, MacroSidebar.tsx:218, WorkflowSidebar.tsx:277, WorkspaceSidebar.tsx:153,
RecentSessionsSidebar.tsx:138), spreading `nav.getItemProps(index)` onto rows and
`role="tree" onKeyDown={nav.onKeyDown}` onto the list. **EmbeddedServerSidebar does neither**:

- no `useFlatRovingNav` import/use;
- its list container `EmbeddedServerSidebar.tsx:163` is a bare `<div className="server-sidebar__list">`
  with no `role="tree"` and no `onKeyDown`;
- `EmbeddedServerItem`'s props interface (`EmbeddedServerItem.tsx:20-34`) omits `rowRef`/`rowProps`,
  so no roving props reach the row (`SidebarListItem` at `:134`).

## Why it matters

Arrow-key and type-ahead navigation that every sibling sidebar shares is silently absent here, so the
services sidebar behaves differently from all the others (keyboard users can't move through the list).
Because the shared hook already exists and every sibling wires it the same way, this is a
consistency/adoption gap, not a design decision. (Accessibility depth is a separate expert's angle;
this finding is about the missing reuse of the shared nav hook.)

## Evidence

- No nav wiring: `EmbeddedServerSidebar.tsx:163`.
- Row can't receive roving props: `EmbeddedServerItem.tsx:20-34`.
- The hook every sibling uses: `src/hooks/useFlatRovingNav.ts`.

## Recommendation

Wire `useFlatRovingNav` into `EmbeddedServerSidebar` exactly as the sibling sidebars do: add
`role="tree" onKeyDown={nav.onKeyDown}` to the list, add `rowRef`/`rowProps` to `EmbeddedServerItem`'s
props, and spread `nav.getItemProps(index)` onto each row.
