# Accessibility audit — termiHub (WCAG 2.2 AA)

Angle: **accessibility** · Reviewer: a11y expert · Method: static reasoning from JSX/ARIA/CSS
(no live screen reader available). Scope: `src/components/**`, `src/components/ui/**`,
`src/hooks/**`, `src/styles`, `src/themes`.

## Overall posture

termiHub's **shared UI primitives are genuinely strong** and are the app's biggest a11y asset.
`Button`, `Modal`, `Select`, `Checkbox`, `Toggle`, `Tooltip`, `Progress`, `Field` are thin,
token-styled skins over Radix (`react-dialog`, `react-select`, `react-checkbox`, `react-switch`,
`react-tooltip`) or a correctly-roled div (`Progress`). That buys, for free and correctly:
focus trap + ESC + scroll-lock + restore on dialogs, real `role`/`aria-checked`/`aria-selected`
states, typeahead, and portal-into-dialog handling. Motion is handled well: a global
`prefers-reduced-motion` backstop (`animations.css`) with an *essential-spinner* opt-out so
progress cues pulse instead of freezing. Icon-only `Button` even warns in the LogViewer when an
accessible name is missing, and `ActivityBarItem` and the terminal tab strip (`role="tablist"` +
roving `tabindex` + Arrow/Home/End, #2071) are done to the WAI-ARIA pattern. Target sizes bottom
out at 24px (`--control-height-sm`), i.e. exactly the WCAG 2.2 2.5.8 minimum.

**Where it falls down is at the feature layer that does NOT compose from those primitives** — most
critically the schema-driven connection forms (`DynamicForm`), which hand-roll labels as `<span>`
and errors as plain `<p>`, and the color-only status dots. Those are the systemic barriers below.

## Systemic issues (fix once, cascade everywhere)

1. **Hand-rolled form scaffolding bypasses the accessible `Field` primitive.** `DynamicForm`
   (`DynamicField.tsx`) — which renders *every* connection-type config form (SSH, serial, telnet,
   Docker, agent, embedded servers) — labels fields with a bare `<span>` (no `htmlFor`), gives
   text/number/password inputs **no `id` and no `aria-label`**, and renders validation errors as a
   plain `<p>` with no `role`, no id, and no `aria-describedby`/`aria-invalid` link. Result: the
   core task of the app (configure a connection) exposes unlabeled edit fields and silent
   validation to screen-reader users. **Level-A hard failures.** (A11Y-001, A11Y-002)
2. **Status conveyed by color alone.** The shared `SidebarStatusDot` is a bare colored `<span>`
   with *no* text alternative at all; other status dots (terminal tab, persistent sessions,
   connection tree, agent nodes) add only a hover `title`, which AT does not reliably announce and
   keyboard users can't reach. (A11Y-003, A11Y-004) — Level A (1.4.1, 1.1.1).
3. **The `Field` primitive stops one wire short.** It emits `htmlFor` + an `id`'d `role="alert"`
   error, but does **not** put `aria-describedby`/`aria-invalid` on the control it wraps — leaving
   that to 94 call sites, ~2 of which do it. Fixing the primitive fixes all of them. (A11Y-005)
4. **Faint focus indicator on primitives.** All primitives use `--shadow-focus` = a 22%-alpha 3px
   ring, overriding global.css's stronger solid double-ring. Weak for low-vision keyboard users.
   (A11Y-007)
5. **The terminal itself is invisible to AT by default** — xterm `screenReaderMode` defaults off.
   (A11Y-006)

## Top barriers (ranked)

| Rank | ID | Barrier | Severity | WCAG (level) |
|------|-----|---------|----------|--------------|
| 1 | A11Y-001 | Connection-form inputs have no programmatic label (span, no `htmlFor`/`id`) | high | 1.3.1, 3.3.2, 4.1.2 (**A**) |
| 2 | A11Y-002 | Connection-form validation errors not announced/associated | high | 3.3.1 (**A**), 4.1.2 |
| 3 | A11Y-003 | Shared `SidebarStatusDot`: status by color, zero text alternative | high | 1.4.1, 1.1.1 (**A**) |
| 4 | A11Y-004 | Other status dots convey state by color + hover `title` only | medium | 1.4.1, 1.1.1 (**A**) |
| 5 | A11Y-005 | `Field` primitive doesn't wire `aria-describedby`/`aria-invalid` to its control | medium | 1.3.1, 3.3.1, 4.1.2 |

Other findings: A11Y-006 (terminal screen-reader mode off by default, medium), A11Y-007 (faint
focus ring, medium), A11Y-008 (management sidebars lack list semantics / arrow roving, low),
A11Y-009 (raw checkbox/radio inputs bypass the primitive — accessible but inconsistent, low).

**Hard WCAG Level-A failures to call out:** A11Y-001, A11Y-002, A11Y-003 (and A11Y-004 shares the
1.4.1 root cause). These exclude blind/low-vision users from the app's primary flow (open and
configure a connection) and from perceiving connection/service state.

## Notes / observations (not filed separately)

- No landmark roles (`<main>`, `<nav>`, `role="complementary"`) delineate the activity bar /
  sidebar / editor regions. Low priority for a single-window desktop app, but a screen-reader user
  gets no structural overview. Consider adding landmarks + `aria-label`s to the top-level regions.
- `body { user-select: none }` globally — fine for chrome, but verify error text / connection
  details the user may want to copy aren't caught by it.
- Contrast of text/token colors is owned by the `ui-visual` expert; this audit only flags the
  *focus-indicator* contrast (A11Y-007) and color-as-sole-signal (A11Y-003/004).
