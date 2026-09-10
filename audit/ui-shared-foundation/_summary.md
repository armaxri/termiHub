# UI Shared-Foundation audit — summary

**Angle:** Do UI features reuse a shared foundation (primitive library, display primitives,
logic/hooks) rather than reinventing? **Scope:** `src/components/` (+ `ui/`), `src/hooks/`,
`src/utils/`, `src/services/`, `src/styles/`, `src/themes/`. Visual design and accessibility are
covered by separate experts; this angle is structural reuse only.

**Headline:** the foundation is real and, in its mature areas, well-adopted — but it is **incomplete
at the primitive layer** (several everyday primitives simply don't exist, so every feature reinvents
them) and **inconsistent at the logic layer** (form state, search, and per-feature helpers are
re-hand-rolled). 20 findings.

## The shared foundation as it exists today

### Primitive library — `src/components/ui/` (good, but has holes)
Exports (index.ts): `Button` (with async lifecycle + spinner), `Input`, `NumberInput`, `Textarea`,
`Field` (label+error), `Select`/`SelectItem`, `Modal`, `ConfirmDialog`, `Toggle`, `Checkbox`,
`Tooltip`, `Progress`, `Toast`, `ErrorBoundary`. Thin token'd skins over Radix / react-hook-form /
sonner. **Widely used** — 150 feature files import from `@/components/ui`, and 46 dialogs build on
`Modal`.

**Missing primitives that features therefore reinvent:** `Spinner` (UISF-001), `EmptyState`
(UISF-002), `RadioGroup` (UISF-009), `SearchInput` (UISF-004), `StatusDot` (only a sidebar-scoped one
exists — UISF-003), `ColorInput` (UISF-016), and a shared `ContentOverlay` for terminal overlays
(UISF-008).

### Composed shared bases (partially adopted)
- **`SidebarListItem` + `SidebarStatusDot`** — status/badge/name/actions row shell. Cleanly adopted
  by the 6 flat management sidebars; **not** by the connection/agent trees (UISF-017), and the status
  dot is under-used app-wide (UISF-003).
- **`DynamicForm`/`DynamicField` + `ConnectionSettingsForm`** — schema-driven connection forms; the
  only RHF+zod form in the app. Bypassed by JumpHostEntry (UISF-014) and by every non-connection
  editor (UISF-011).
- **`PasswordInput`** — well-adopted (one bypass, UISF-015).
- **NetworkTools** — a genuinely good citizen: shared `useNetworkTask` hook +
  `NetworkDiagnosticPanel` + `DiagnosticResultsTable` + `NetworkToolRunLocation` (minor gap: DnsLookup
  and Wol panels don't use `useNetworkTask`).

### Shared hooks (`src/hooks/`) and utils (`src/utils/`) — strong where they exist
- Good, well-adopted hooks: `useFlatRovingNav`/`useRovingListNav`/`useTreeSelection` (list/tree
  keyboard nav), `useAutofocusSelect`, `useSidebarResize`/`useSectionResize`, `useKeyboardShortcuts`,
  and a large family of domain hooks (`useConnections`, `useTerminal`, `useTransferEvents`, …).
- Good, well-adopted utils: `connectionSearch`/`agentTreeSearch` (tree filtering), `connectionIcons`
  (icon mapping, 9 consumers), `formatters`, `tabStatus`/`tabLiveSession` (connection-state
  derivation).
- **Gaps:** no `useDebounce` (UISF-005), no shared search-query/list-filter hook (UISF-004/UISF-020),
  and several pure helpers are copy-pasted instead of living in utils (UISF-016).

### Styling foundation — the healthiest layer
`src/styles/variables.css` (tokens) + `ui.css`, with a `tokenDiscipline.test.ts` regression guard
that blocks ad-hoc dark scrims, hardcoded white foregrounds, and per-component scrollbar overrides.
Token discipline is actively enforced, so structural styling reuse is in good shape — the reuse gaps
are in components/logic, not tokens. (No dedicated token-abuse finding raised for that reason.)

## Reuse scorecard (good vs bad citizens)

| Area | Grade | Notes |
|---|---|---|
| NetworkTools | A | Shared task hook + panel + results table; near-textbook reuse |
| Flat management sidebars (Tunnel/Macro/Workflow/Workspace/RecentSessions) | B | Use SidebarListItem + roving nav; but reinvent toolbar/search/empty-state + copy-paste logic (UISF-019/020) |
| Dialogs on Modal | B | Almost all use Modal; confirm-shaped ones reinvent ConfirmDialog (UISF-006) |
| Settings panels | C | Own field wrapper (SettingsField, no error slot) + many raw inputs + repeated empty/loading (UISF-002/012/013) |
| ConnectionEditor | C | Routes connection fields through the schema form (good) but hand-rolls all metadata state + name/label/error markup (UISF-011/012) |
| EmbeddedServer sidebar+dialog | D | No keyboard nav (UISF-018); bespoke label/fieldset system + 6 raw checkbox/radio inputs (UISF-009/012/013) |
| JumpHostEntry | D | Hand-renders the SSH connection form instead of the schema (UISF-014) |
| Connection/Agent trees | C | Own row markup, duplicated between ConnectionList and AgentNode (UISF-017) |
| Terminal/RDP overlays | D | Same overlay skeleton implemented 4× (UISF-008) |
| Loading/empty/status display | D | No Spinner/EmptyState/StatusDot primitive → ~24 spinner + ~20 empty + many dot reinventions (UISF-001/002/003) |

## Top consolidation opportunities (highest leverage first)

1. **Fill the primitive gaps** — add `Spinner`, `EmptyState`, `RadioGroup`, `SearchInput`,
   `StatusDot`, `ColorInput`, `ContentOverlay` to `src/components/ui/` and migrate. This alone retires
   ~24 spinner sites, ~20 empty-state sites, 6 radio hand-rolls, and the app-wide status-dot sprawl
   (UISF-001/002/003/004/008/009/016).
2. **Standardise editor form handling on RHF+zod** with a `useEditorForm` wrapper, and route field
   errors through `ui/Field`; consolidate the three field-wrapper conventions into one
   (UISF-011/012). Biggest logic-duplication win.
3. **Make JumpHostEntry schema-driven** — the clearest architecture violation (UISF-014).
4. **Extract sidebar chrome + shared sidebar logic hooks** (`SidebarToolbar`, `SidebarGroupHeader`,
   `useListFilter`, `useJsonFileImport/Export`, `useDeleteConfirm`) and shared tree row components; a
   sidebar becomes toolbar + search + `SidebarListItem` list + empty-state from shared parts
   (UISF-017/018/019/020).
5. **Unify the confirm/dialog layer** — migrate confirm-shaped dialogs onto `ConfirmDialog`, merge the
   duplicated SSH/RDP trust prompt, and settle footer action-row markup (UISF-006/007/010).

## Finding index

| ID | Sev | Title |
|---|---|---|
| UISF-001 | medium | No shared Spinner/loading-indicator primitive |
| UISF-002 | medium | No shared EmptyState / empty-and-loading primitive |
| UISF-003 | low | Status dot reinvented app-wide despite SidebarStatusDot |
| UISF-004 | medium | No shared search-input primitive or filter hook |
| UISF-005 | low | No shared useDebounce hook |
| UISF-006 | medium | Confirm dialogs hand-roll footer/focus instead of ConfirmDialog |
| UISF-007 | medium | SSH host-key prompt and RDP cert prompt are the same dialog twice |
| UISF-008 | medium | Terminal/RDP overlays duplicate one skeleton 4× (no ContentOverlay) |
| UISF-009 | medium | Raw radio/checkbox/select bypass ui; no RadioGroup exists |
| UISF-010 | low | Modal footer action-row markup inconsistent |
| UISF-011 | high | RHF+zod used in one form only; editors hand-roll state+validation |
| UISF-012 | medium | Three competing field-wrapper conventions |
| UISF-013 | medium | Raw text `<input>` bypasses ui/Input |
| UISF-014 | high | JumpHostEntry hand-renders SSH form instead of the schema |
| UISF-015 | low | SaveAsConnectionDialog bypasses PasswordInput |
| UISF-016 | low | Small utility helpers copy-pasted across features |
| UISF-017 | medium | Tree rows bypass SidebarListItem and duplicate ConnectionList↔AgentNode |
| UISF-018 | medium | EmbeddedServerSidebar has no keyboard nav (bypasses useFlatRovingNav) |
| UISF-019 | medium | No shared sidebar chrome (toolbar/header/export-import) |
| UISF-020 | medium | Sidebar stateful logic copy-pasted (filter/import/export/delete-confirm) |
