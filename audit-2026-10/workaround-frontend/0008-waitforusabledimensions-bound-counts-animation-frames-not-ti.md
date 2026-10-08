---
id: WA-FE2-008
title: "waitForUsableDimensions bound counts animation frames, not time, so a reattach stalls indefinitely in a hidden or occluded window"
angle: workaround-frontend
severity: low
category: workaround
is_workaround: true
subsystem: "components/Terminal (persistent-session reattach)"
evidence:
  - src/components/Terminal/Terminal.tsx:156
  - src/components/Terminal/Terminal.tsx:163
  - src/components/Terminal/Terminal.tsx:170
  - src/components/Terminal/Terminal.tsx:174
  - src/components/Terminal/Terminal.tsx:182
  - src/components/Terminal/Terminal.tsx:662
  - src/components/Terminal/safeFit.ts:74
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The reattach path waits for a usable container by looping up to `MAX_REATTACH_FIT_FRAMES = 180` iterations of `await requestAnimationFrame`. The doc comment says it is 'bounded by ~3 s', but rAF does not fire in a minimized or occluded window (WKWebView throttles occluded views, as noted in the project's reconnect notes). In that state the bound never elapses and the reattach (buffer replay plus output subscription) stalls until the window is shown. The loop also calls `fitAddon.fit()` once `offsetWidth >= 50` without the `isProposedFitSafe` guard used everywhere else since #2700, so a narrow transitional container can still resize xterm to a few columns before the cols check.

## Why it matters

This is a timing heuristic whose actual bound differs from its documentation, sitting on the persistent-session reattach path. Reattaches in background or secondary windows silently hang, and the unguarded fit reintroduces the narrow-reflow risk that #2693/#2700 closed elsewhere.

## Evidence

- `src/components/Terminal/Terminal.tsx:156`
- `src/components/Terminal/Terminal.tsx:163`
- `src/components/Terminal/Terminal.tsx:170`
- `src/components/Terminal/Terminal.tsx:174`
- `src/components/Terminal/Terminal.tsx:182`
- `src/components/Terminal/Terminal.tsx:662`
- `src/components/Terminal/safeFit.ts:74`

## Recommendation

Bound the loop by wall-clock time (`Date.now() - start < 3000`), and race each rAF against a short setTimeout so it advances when rAF is throttled. Gate the fit on `isProposedFitSafe(fitAddon)` (safeFit.ts:74) instead of a raw offsetWidth floor. Update the comment to match.

## Verification

Confirmed. Terminal.tsx:163-182 bounds the reattach wait by MAX_REATTACH_FIT_FRAMES=180 rAF iterations while the doc says '~3 s'. rAF does not fire in occluded or hidden WKWebView windows (the project notes record occlusion throttling), so the bound is not wall-clock. The loop calls fitAddon.fit() once offsetWidth>=50 without the isProposedFitSafe guard (safeFit.ts) used elsewhere, so a narrow transitional container can briefly resize xterm and the PTY before the cols>=20 check. Impact is limited: a hidden window renders nothing anyway, and the stall resolves once the window is shown.
