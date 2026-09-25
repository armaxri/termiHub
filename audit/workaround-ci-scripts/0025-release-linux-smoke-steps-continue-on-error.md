---
id: WA-CI-025
title: release-linux-smoke GUI-launch steps are continue-on-error (gated by a separate enforce step)
angle: workaround-ci-scripts
severity: low
category: workaround
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/release-linux-smoke.yml:202
  - .github/workflows/release-linux-smoke.yml:218
  - .github/workflows/release-linux-smoke.yml:237
status: open
---

## What
In `release-linux-smoke.yml` the two headless GUI-launch smoke steps are
`continue-on-error: true` (lines 202, 218) with `# #2646: the built app may not launch headless
… yet` comments, and a later "Enforce smoke results" step (line 237, `if: always()`,
`ENFORCE: "true"`) reads their `outcome`s and fails the job on any non-success. The comments say
the gate is now enforcing (#2669) since #2646 was fixed.

## Why it matters
The pattern (run-with-continue-on-error, then enforce in a summary step) is a legitimate way to
capture both outcomes together — but the per-step `# may not launch … yet` comments and
`ENFORCE`/advisory scaffolding are leftovers from when #2646 was open and the gate was
deliberately *non*-enforcing. It reads as a workaround-in-transition: the safety net is now
enforcing, yet the "advisory until #2646 lands" branch and comments remain.

## Evidence
`continue-on-error: true` (lines 202, 218); "Enforce smoke results" with the advisory fallback
warning still present (lines 237-260).

## Recommendation
Now that #2646/#2669 are resolved and the gate enforces, clean up the residue: drop the "may not
launch yet / advisory until #2646 lands" comments and the dead advisory branch so the workflow
plainly states the smoke is load-bearing. Keep the continue-on-error + enforce pattern (it is
intentional). Low.
