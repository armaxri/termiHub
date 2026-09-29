---
id: UX-001
title: Connections panel has no first-run empty state or create-first-connection CTA
angle: ux-flows
severity: high
category: ux
is_workaround: false
subsystem: src/components/Sidebar/ConnectionList
evidence:
  - src/components/Sidebar/ConnectionList.tsx:1664
  - src/components/Sidebar/ConnectionList.tsx:1681
  - src/store/appStore.ts:2817
  - src/components/Sidebar/ConnectionList.tsx:1299
status: fixed
resolution: "#2762 — connections empty-state + CTA"
---

## What
On first launch the sidebar defaults to the Connections view (`appStore.ts:2817` —
`sidebarView: "connections"`), which is the primary and most important panel for
time-to-first-connection. When there are zero saved connections and no folders, the
connection tree renders as an **empty `<div role="tree">` with nothing inside** — no
"Add your first connection" prompt, no explanation, no pointer to the toolbar button.

The only empty-state text in the whole component is filter-gated: `filter && !hasVisibleResults`
→ "No connections match "{query}"." (`ConnectionList.tsx:1681-1685`). A brand-new user with
zero connections has never typed a filter, so they see a completely blank pane.

## Why it matters
This is the single most important panel for a new user's first success, and it is the *only*
list panel in the app with no empty state. Every sibling sidebar has a proper zero-state with a
CTA (Workspaces `WorkspaceSidebar.tsx:210-212`; Macros `MacroSidebar.tsx:274-278`; Tunnels
`TunnelSidebar.tsx:148-150`; Recent Sessions `RecentSessionsSidebar.tsx:173-174`; Workflows
`WorkflowSidebar.tsx:366-370`; Services `EmbeddedServerSidebar.tsx:158-160`). The one panel that
governs onboarding is the one left blank. The only always-visible create affordance is an
icon-only `<Plus>` button discoverable purely by hover tooltip (`ConnectionList.tsx:1299-1306`),
so nothing directs a new user to it. Combined with no welcome screen anywhere (see UX-004), a
first-run user faces an empty window with no path forward.

## Evidence
- `ConnectionList.tsx:1664-1733` — the `connection-list__tree` container maps folders/connections;
  when both arrays are empty it renders no placeholder.
- `ConnectionList.tsx:1681-1685` — the sole empty message is `filter && !hasVisibleResults`.
- `appStore.ts:2817` — `sidebarView` defaults to `"connections"`, `sidebarCollapsed: false`.
- `ConnectionList.tsx:1299-1306` — "New Connection" is an icon-only button with a hover tooltip.

## Recommendation
Add a true zero-connections empty state to the connection tree, mirroring the pattern the other
sidebars already use: a short line ("No connections yet") plus a prominent labelled CTA ("+ New
Connection") and, ideally, a secondary "Import from ~/.ssh/config" link (the bulk-import dialog
already exists). This is a small, self-contained change with outsized onboarding impact.
