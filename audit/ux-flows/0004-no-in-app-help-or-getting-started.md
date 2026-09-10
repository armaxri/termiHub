---
id: UX-004
title: No in-app help, getting-started, or welcome surface anywhere
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/ActivityBar
evidence:
  - src/components/ActivityBar/ActivityBar.tsx:160
  - README.md:423
status: open
---

## What
There is no dedicated onboarding, welcome screen, product tour, first-run guidance, or in-app help
surface anywhere in the app. A grep for `welcome|onboard|first-run|getting-started|tour|
walkthrough|tutorial` across `src/` returns only `FleetOnboardDialog` (an unrelated bulk-CSV-import
feature) and internal comments. The Settings gear menu (`ActivityBar.tsx:160-247`) contains
Keyboard Shortcuts, Customize Layout, Open Connections, Import/Export, Updates, and About — but
**no "Help", "Getting Started", or "Docs" entry**. The only informational surface is About
(`ActivityBar.tsx:239-246`).

The README's "Quick Start" (`README.md:423`) is entirely developer-facing (clone/build/dev), and
docs/concepts/ has 40+ concept docs but **none for onboarding or a getting-started tour**. So
onboarding is neither documented nor implemented — it is simply absent from the product.

## Why it matters
A confused new user has no in-app path to guidance. Combined with the blank Connections panel
(UX-001) and hidden feature areas (UX-002), the first-run experience offers no orientation at all.
For an unsigned beta whose *documented* first-run experience is a Gatekeeper/SmartScreen warning
(`README.md:25,31`), the lack of any follow-up guidance once the app opens is a notable gap.

## Evidence
- `ActivityBar.tsx:160-247` — Settings menu items; About only, no Help/Getting-Started/Docs.
- No onboarding keywords in `src/` (grep); no onboarding concept in `docs/concepts/`.
- `README.md:423` — Quick Start is build-from-source only.

## Recommendation
Add at minimum a "Getting Started" / "Help" entry to the Settings menu that links to docs or opens
an in-app overlay covering: create a connection, connect, the activity bar, and where advanced
features live. Consider a lightweight one-time welcome card on first launch (dismissible), reusing
the existing overlay-view infrastructure (`openOverlayView`).
