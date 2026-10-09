---
id: FES2-007
title: "Session-keyed sessionCapabilities and sessionHighlighting maps are never pruned when a session ends"
angle: frontend-state
severity: info
category: state-integrity
is_workaround: false
subsystem: src/store/slices
evidence:
  - src/store/slices/monitoringSlice.ts:76
  - src/store/slices/monitoringSlice.ts:100
  - src/store/slices/layoutSlice.ts:281
  - src/store/slices/sessionHighlightingSlice.ts:21
  - src/store/slices/sessionHighlightingSlice.ts:31
status: fixed
resolution: "#4313 — sessionCapabilities and sessionHighlighting pruned on session replace, session end and tab close or move"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

setSessionCapabilities adds an entry for every new session id: every connect, reconnect and fresh-shell gets a new backend session id. No action removes these entries. sessionHighlighting is cleared only when the user toggles the override back to 'follow config'. remoteDesktopResolutions, by contrast, is cleared on unmount.

## Why it matters

Both maps grow without bound over a long-running app session, a small leak per session. A reconnect produces a new session id, so the old entries become permanently stale. This is the same 'integrity by convention' gap as FES-003, applied to session-keyed rather than tab-keyed maps.

## Evidence

- `src/store/slices/monitoringSlice.ts:76`
- `src/store/slices/monitoringSlice.ts:100`
- `src/store/slices/layoutSlice.ts:281`
- `src/store/slices/sessionHighlightingSlice.ts:21`
- `src/store/slices/sessionHighlightingSlice.ts:31`

## Recommendation

Drop sessionCapabilities[oldId] and sessionHighlighting[oldId] when a tab's sessionId is replaced (setTabSessionId, layoutSlice ~:281 / :307) and when the tab closes (closeTab prune). Alternatively, prune them on the terminal-exit path.

## Verification

Confirmed. The only writers are setSessionCapabilities (monitoringSlice.ts:102, add-only) and setSessionHighlighting, which removes an entry only on an explicit undefined. Nothing prunes either map on a session end or a session-id change. The growth is technically unbounded, but each entry is a few bytes, and sessionHighlighting entries exist only after a manual user toggle. This is a negligible hygiene leak, so info rather than low.
