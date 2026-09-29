---
id: MKT-007
title: No end-user "first connection" quickstart — onboarding jumps straight into a reference manual
angle: marketing / onboarding funnel
severity: medium
category: docs
is_workaround: false
subsystem: README.md
evidence:
  - README.md:127
  - README.md:423
status: open
---

## What
After Install, the README goes directly into a dense reference-style "Usage Guide"
(README.md:127+) — Interface Overview, Managing Connections, Tabs, Splits, File Browser, etc.
There is no short **"connect to your first server in 3 steps"** happy path. The only block
literally titled "Quick Start" (README.md:423) is the **developer** clone/build flow, not an
end-user getting-started.

So the funnel from "installed" to "first successful connection" is: read a multi-section manual
and self-assemble the path. There is no minimal, confidence-building first-run walkthrough
(open app → New Connection → pick SSH → enter host/user → Connect).

## Why it matters
The moment after install is where users churn. A crisp 3–5 step first-connection quickstart
(ideally with one screenshot) converts an installed binary into an activated user. This ties to
the separately-filed absent-onboarding UX finding: if the app has no in-product onboarding
either, the README quickstart is the only safety net — and it's missing. A reference manual is
valuable but it is not onboarding; the two serve different readers.

## Evidence
- `README.md:127-249` — "Usage Guide" is reference material, not a guided first run.
- `README.md:423-432` — the "Quick Start" heading is the dev build flow, not user onboarding.

## Recommendation
- Add a short **"Getting started"** section right after Install: 3–5 numbered steps to first
  connection, each with its expected result, plus one screenshot.
- Rename the developer "Quick Start" to "Developer quick start" to avoid the collision.
- Optionally add a "Your first SSH connection" and "Your first remote desktop" mini-walkthrough,
  since those are the highest-value activations.
