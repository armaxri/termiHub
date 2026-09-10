---
id: UISF-004
title: No shared search-input primitive or filter hook — ~15 features hand-roll search box + filter state
angle: ui-shared-foundation
severity: medium
category: ui
is_workaround: false
subsystem: src/components/ui
evidence:
  - src/components/Settings/SettingsSearch.tsx
  - src/components/Terminal/TerminalSearchBar.tsx
  - src/components/RecentSessionsSidebar/QuickConnectBar.tsx
  - src/components/ConnectionEditor/IconPickerDialog.tsx
  - src/components/Plugins/PluginManagerView.tsx
  - src/components/KeyboardShortcuts/ShortcutsOverlay.tsx
  - src/components/StatusBar/StatusBar.tsx
  - src/components/WorkspaceEditor/ConnectionPicker.tsx
  - src/components/Settings/LanguagePackagesSettings.tsx
  - src/components/CommandPalette/CommandPalette.tsx
status: open
---

## What

At least ~15 components implement their own "search box + query state + filter" UI. There is a
shared **filter/match logic** layer in `src/utils/` (`connectionSearch.ts`, `agentTreeSearch.ts`,
`connectionSearch`) and shared **result-list keyboard nav** hooks (`useRovingListNav`,
`useFlatRovingNav`), but there is **no shared search-*input* primitive** and no shared hook that
bundles "query state + debounce + clear button + filtered result". So each feature re-hand-rolls:

- a raw `<input>` (often with a magnifier icon + clear button) styled per-component, and
- a `useState('')` query + an ad-hoc `.filter(...)`/`.includes(...)` predicate.

Sites with their own search state: `Settings/SettingsSearch.tsx`, `Terminal/TerminalSearchBar.tsx`,
`RecentSessionsSidebar/QuickConnectBar.tsx`, `ConnectionEditor/IconPickerDialog.tsx`,
`Plugins/PluginManagerView.tsx`, `KeyboardShortcuts/ShortcutsOverlay.tsx` (language filter also in
`StatusBar/StatusBar.tsx`), `WorkspaceEditor/ConnectionPicker.tsx`,
`Settings/LanguagePackagesSettings.tsx`, `Settings/KeyboardSettings.tsx`,
`WorkflowSidebar/WorkflowSidebar.tsx`, `MacroSidebar/MacroSidebar.tsx`, `LogViewer/LogViewer.tsx`,
`CommandPalette/CommandPalette.tsx`, `NetworkTools/DnsLookupPanel.tsx`.

## Why it matters

Search is one of the most-repeated interactions in the app and every instance re-solves the same
sub-problems (placeholder text, clear-on-Escape, magnifier icon, empty-result message, case-folding).
Behaviour drifts: some clear on Escape, some don't; some debounce, some filter on every keystroke;
some use the shared `connectionSearch` matcher, others inline `String.includes`. A shared
`SearchInput` primitive + a `useFilter`/`useSearchQuery` hook would unify look, keyboard behaviour,
and matching, and pair naturally with the existing roving-nav hooks.

## Evidence

See frontmatter for the site list. The matching logic is already partly centralised
(`src/utils/connectionSearch.ts`, `agentTreeSearch.ts`) but the input widget and query-state
management are not, so callers reinvent both around the shared matcher (or bypass it).

## Recommendation

Add a `SearchInput` primitive to `src/components/ui/` (Input skin with leading icon + clear button +
Escape-to-clear) and a `useSearchQuery`/`useFilter` hook that owns query state, optional debounce,
and returns the filtered slice via an injected matcher (defaulting to the `connectionSearch`
helpers). Migrate the ~15 sites. Also see UISF-005 (no `useDebounce`), which this hook subsumes.
