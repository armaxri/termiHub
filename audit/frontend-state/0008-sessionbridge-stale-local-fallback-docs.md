---
id: FES-008
title: sessionBridge docs and fallback-log messages still describe a deleted local lifecycle fallback
angle: frontend-state
severity: low
category: docs
is_workaround: true
subsystem: src/store/sessionBridge
evidence:
  - src/store/sessionBridge.ts:899
  - src/store/sessionBridge.ts:922
  - src/store/sessionBridge.ts:1053
  - src/store/sessionBridge.ts:675
status: fixed
resolution: "#2730"
---

## What
After the session-lifecycle inversion (#2283 / #2205 PR-B) the backend `SessionLifecycleStore`
is the sole authority and the per-client local slices were deleted, but the bridge's docs and
log strings still describe the removed local-fallback path:

- `effectiveReconnecting` (`:899-905`) and `effectiveReconnectTriggerError` (`:922-938`) docs say
  they return "the local bool verbatim" / fall back to a local slice — but the surrounding code
  states the local slices were deleted and the region is the sole source (`:893,908-915`).
- `logSessionBridgeFallback` messages (`:1053`) still read "fell back to local lifecycle", though
  there is no local lifecycle to fall back to.
- The render-cut section header (`:675-691`) describes the intermediate PR-A state ("appStore
  keeps its slices … reducer/authority removal is PR-B"), now superseded by PR-B.

## Why it matters
Low-severity but real doc/code drift on the safety-adjacent reconnect path. A reader debugging a
stuck-reconnect (a repeated bug area on this app) will be told the code falls back to a local
slice that no longer exists, sending them to the wrong layer. It is the same post-inversion
residue as FES-007, in a second file, and should be swept at the same time.

## Evidence
- `src/store/sessionBridge.ts:899-905`, `:922-938` — "local bool verbatim" fallback phrasing.
- `src/store/sessionBridge.ts:1053` — "fell back to local lifecycle" log message.
- `src/store/sessionBridge.ts:675-691` — stale PR-A render-cut header.

## Recommendation
Rewrite these comments and log strings to describe the region-authoritative reality (the
`effective*` readers source purely from the projected session view; there is no local fallback).
Pure docs/strings change — bundle with the FES-007 post-inversion cleanup.
