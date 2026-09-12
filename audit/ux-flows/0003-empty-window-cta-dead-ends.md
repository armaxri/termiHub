---
id: UX-003
title: Empty-window CTA dead-ends into the blank Connections panel and shows power-user copy to new users
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/SplitView/EmptyWindowState
evidence:
  - src/components/SplitView/EmptyWindowState.tsx:30
  - src/components/SplitView/EmptyWindowState.tsx:47
status: fixed
resolution: "#2845 — empty-window Open Connection opens CommandPalette (≥1 conn) or new-connection editor (0 conn) instead of just revealing sidebar; first-run copy; multi-window hint gated on window count. UX-001 already fixed on develop"
---

## What
The main content area's empty state (`EmptyWindowState.tsx:40-73`) is the closest thing termiHub
has to onboarding: a centered card with "New Terminal" (primary) and "Open Connection…"
(secondary). Two problems for a first-run user:

1. **The secondary CTA dead-ends.** "Open Connection…" (`:30-38`) only *reveals the Connections
   sidebar* — it opens no picker and highlights nothing. A first-run user with zero saved
   connections clicks it and lands on the blank Connections panel (see UX-001), a dead end.
2. **The sub-copy is power-user noise.** `:47-50` reads "Start a session here, or move a tab in
   from another window with **Tab ▸ Move to Window**." The first sentence a new user reads is half
   about a multi-window workflow and references a menu they have never seen.

## Why it matters
This card is shown exactly when guidance matters most (an empty window / first run), yet its
secondary action leads nowhere useful and its copy assumes prior product knowledge. It squanders
the one onboarding surface the app has.

## Evidence
- `EmptyWindowState.tsx:30-38` — "Open Connection…" only toggles the Connections sidebar visible.
- `EmptyWindowState.tsx:47-50` — multi-window "Move to Window" instruction in the primary copy.

## Recommendation
Make "Open Connection…" open an actual connection picker (or, when there are zero connections,
route to the create-connection flow). Replace the multi-window sentence with first-run-appropriate
guidance ("Create a connection to save it for next time, or start a local terminal now"). Only
surface the multi-window hint contextually (e.g. when more than one window exists).
