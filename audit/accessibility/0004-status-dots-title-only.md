---
id: A11Y-004
title: Terminal/session/agent status dots convey state by color plus a hover title only
angle: accessibility
severity: medium
category: a11y
is_workaround: false
subsystem: src/components (multiple sidebars + tab bar)
evidence:
  - src/components/Terminal/Tab.tsx:171
  - src/components/Sidebar/PersistentStateDot.tsx:54
  - src/components/Sidebar/AgentNode.tsx:1216
status: open
---

## What

Across the app, connection/session/agent state is shown with a small colored dot whose only
non-visual information is a `title` attribute on a non-interactive `<span>`:

- **Terminal tab state dot** (`Tab.tsx:171`): `<span className="tab__state-dot tab__state-dot--${status}" title={STATUS_LABELS[status]} />` — connecting / reconnecting / error / connected shown by color, label only in `title`.
- **Persistent-session dot** (`PersistentStateDot.tsx:54`): `<span className="connection-tree__state-dot …" title={tooltip} />` — run-state by color, word/name only in `title`.
- **Agent node dot** (`AgentNode.tsx:1216`): connected / connecting / reconnecting / disconnected by color class, no text.
- Similar dots in `TunnelListItem`, `ShellIntegrationSettings`, `UpdateIndicator`, update
  notifications.

`title` on a non-focusable, non-interactive element is **not reliably surfaced by screen readers**
and is **only reachable by mouse hover** — keyboard and touch users never see it.

## Why it matters

- **WCAG 1.4.1 Use of Color (A)** — dot color is the sole reliably-perceivable status signal.
- **WCAG 1.1.1 Non-text Content (A)** — a `title` is a weak/unreliable text alternative for a
  status graphic, and provides nothing to keyboard-only users.

This is a notch less severe than A11Y-003 (those dots have *zero* alternative), because a mouse
user with some AT may get the `title`. Still a Level-A use-of-color problem on core status.

## Evidence

`src/components/Terminal/Tab.tsx:171`:

```tsx
{status && (
  <span
    className={`tab__state-dot tab__state-dot--${status}`}
    title={STATUS_LABELS[status]}         // hover-only, unreliable for AT
    data-testid={`tab-state-dot-${tab.id}`}
  />
)}
```

## Recommendation

- Give each dot a real accessible name: `role="img"` + `aria-label` (or a visually-hidden text
  span) carrying the status word — for the tab dot this also complements `aria-selected` already on
  the tab.
- Differentiate the states by shape/glyph as well as color (see A11Y-003) so colorblind users can
  distinguish connecting vs error vs connected.
- Prefer the shared `Tooltip` primitive over a bare `title=` where hover help is wanted (it wires
  `role="tooltip"` and is focus-reachable), but keep an explicit `aria-label` regardless — a
  tooltip is not an accessible name.
