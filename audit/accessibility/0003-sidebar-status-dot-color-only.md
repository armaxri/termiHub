---
id: A11Y-003
title: Shared SidebarStatusDot conveys status by color alone with no text alternative
angle: accessibility
severity: high
category: a11y
is_workaround: false
subsystem: src/components/SidebarListItem
evidence:
  - src/components/SidebarListItem/SidebarListItem.tsx:19
status: open
---

## What

`SidebarStatusDot`, the shared status indicator composed into management sidebars (embedded
services today, workspaces, and — per its own doc comment — tunnels to follow), is a bare colored
`<span>` with **no** text alternative of any kind: no `aria-label`, no `title`, no visually-hidden
text, no `role="img"`.

```tsx
export function SidebarStatusDot({ tone, testId }): React.ReactElement {
  return (
    <span
      className={`sidebar-list-item__status sidebar-list-item__status--${tone}`}
      data-testid={testId}
    />
  );
}
```

The tone (`neutral` / `success` / `warning` / `error`) is expressed purely through the token color
of the modifier class. A screen-reader user gets nothing; a colorblind user cannot distinguish
success (green) from error (red).

## Why it matters

Whether an embedded HTTP/FTP/TFTP server is running, starting, stopped, or errored is meaningful
state the user acts on. Conveying it only by dot color fails:

- **WCAG 1.4.1 Use of Color (A)** — color is the *sole* visual means of conveying the status.
- **WCAG 1.1.1 Non-text Content (A)** — the status graphic has no text alternative.

Because this is a *shared* primitive, the barrier is inherited by every sidebar that adopts it, so
one fix cascades.

## Evidence

`src/components/SidebarListItem/SidebarListItem.tsx:19-26` — the component body above. Callers
(e.g. `EmbeddedServerItem.tsx`) pass only a `tone`; there is no place to supply a label, so even a
conscientious caller cannot name the state.

## Recommendation

- Add a required (or strongly-encouraged) `label` prop and render it as the accessible name:
  `role="img"` + `aria-label={label}` (e.g. "Running", "Stopped", "Error"), or an adjacent
  visually-hidden `<span className="sr-only">`.
- Pair color with a shape/glyph difference (e.g. filled vs hollow vs warning triangle) so the four
  tones are distinguishable without color — satisfies 1.4.1 for colorblind sighted users too.
- Provide a `.sr-only` utility in global CSS if one doesn't exist, so every dot/icon-only affordance
  can carry hidden text consistently.
- Test: each tone exposes a distinct accessible name.
