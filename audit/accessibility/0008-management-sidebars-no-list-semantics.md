---
id: A11Y-008
title: Management sidebar lists lack list semantics and arrow-key roving navigation
angle: accessibility
severity: low
category: a11y
is_workaround: false
subsystem: src/components/EmbeddedServerSidebar, src/components/SidebarListItem
evidence:
  - src/components/EmbeddedServerSidebar/EmbeddedServerSidebar.tsx:163
  - src/components/SidebarListItem/SidebarListItem.tsx:84
status: open
---

## What

The management sidebars built on `SidebarListItem` (embedded services; workspaces) render their
rows in a plain `<div className="…__list">` of plain `<div>` rows — no `role="list"`/`listitem`, no
container-level roving `tabindex`, no Arrow/Home/End key handling. Compare the terminal tab strip
(`role="tablist"` + roving nav, #2071) and `ConnectionList` (its own roving), which do this
properly.

Keyboard operability itself is **not broken**: `SidebarListItem`'s action buttons are real
`<Button>`s, and the reveal CSS keys on `:focus-within` as well as `:hover`
(`SidebarListItem.css:78-79`, `opacity: 0 → 1`), so a keyboard user *can* Tab into each row's
actions and they become visible. The gap is (a) missing list structure/semantics for AT overview,
and (b) no arrow-key roving — so navigating N services means Tab-stepping through N×(3–5) buttons
rather than arrowing between rows.

## Why it matters

- **WCAG 1.3.1 Info and Relationships (A)** — the list is not exposed as a list; a screen-reader
  user gets no "list, N items / item 2 of N" structure.
- Efficiency (not a strict SC): every hidden action button is a tab stop, so a keyboard user pays a
  large tab-count to cross a populated sidebar. The roving pattern used elsewhere in the app would
  fix this and make the sidebars consistent.

Low severity because the controls are reachable and operable; this is a structure/efficiency gap,
not an exclusion.

## Evidence

- `src/components/EmbeddedServerSidebar/EmbeddedServerSidebar.tsx:163` —
  `<div className="server-sidebar__list" data-testid="server-list">` wrapping `EmbeddedServerItem`s.
- `src/components/SidebarListItem/SidebarListItem.tsx:84` — row is `<div … {...rest}>` with no
  default role/tabindex (callers *may* spread them, but these sidebars don't).
- Reveal-on-focus works: `SidebarListItem.css` lines 78-79
  (`:hover …__actions, :focus-within …__actions { opacity: 1 }`).

## Recommendation

- Add `role="list"` to the container and `role="listitem"` to rows (or use real `<ul>/<li>`), and an
  `aria-label` naming the sidebar.
- Adopt the existing roving-nav hook (`useRovingListNav` / the pattern in `TabBar`/`ConnectionList`)
  so Arrow/Home/End move between rows and only one row is in the tab sequence.
- Keep the `:focus-within` reveal so a focused row surfaces its actions.
