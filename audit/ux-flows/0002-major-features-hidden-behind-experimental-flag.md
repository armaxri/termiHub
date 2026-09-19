---
id: UX-002
title: Tunnels, Services, Network Tools and Workflows are hidden behind an experimental flag
angle: ux-flows
severity: high
category: ux
is_workaround: false
subsystem: src/components/ActivityBar
evidence:
  - src/components/ActivityBar/ActivityBar.tsx:64
  - src/components/ActivityBar/ActivityBar.tsx:120
status: fixed
resolution: "#2762"
---

## What
Four major feature areas — **SSH Tunnels, Services (embedded servers), Network Tools, and
Workflows** — are marked `experimental: true` in the activity-bar item list
(`ActivityBar.tsx:64-74`) and filtered out of the primary navigation on a default install:
`ActivityBar.tsx:120-122` renders an optional item only when `(!item.experimental || experimental)`.
So on a fresh install these areas are entirely absent from the activity bar, with no in-app hint
that they exist or how to reveal them (the enabling flag lives in Settings → General →
Experimental Features).

## Why it matters
These are headline capabilities the product markets (tunnels are "feature-complete across all
three directions" per the product-completeness audit; network tools are a full ping/traceroute/
port-scanner/DNS/WoL/HTTP-monitor suite). A default-install user cannot discover any of them from
the primary navigation, and there is no affordance pointing them at the experimental toggle. This
is finished, shipped functionality made undiscoverable by a flag — the "feature flag left off that
hides finished work" pattern, experienced as missing features.

## Evidence
- `ActivityBar.tsx:60-62` — `REQUIRED_ITEMS`: only Connections is always shown.
- `ActivityBar.tsx:64-74` — `OPTIONAL_ITEMS`: Tunnels/Services/Network Tools/Workflows carry
  `experimental: true`.
- `ActivityBar.tsx:120-122` — filter drops experimental items unless the flag is on.

## Recommendation
For v0.1.0, decide per-area whether the feature is release-ready and, if so, remove the
`experimental` gate so it appears in the activity bar by default. For any area genuinely still in
preview, add a visible, discoverable entry point (e.g. a "More features" affordance or a one-time
hint) rather than hiding it entirely behind a Settings flag with no in-app signpost.
