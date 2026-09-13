---
id: SM-014
title: System-monitoring Reconnecting state has no UI representation — stale data un-dims during backoff
angle: state-machine-ux
severity: medium
category: ux
is_workaround: false
subsystem: src/components/StatusBar.tsx + src/components/OpenConnectionsModal.tsx
evidence:
  - core/src/monitoring/status.rs:245
  - src/components/StatusBar.tsx:773
  - src/components/OpenConnectionsModal.tsx:1338
status: open
---

## What
The backend emits a `Reconnecting` monitor status during the reconnect backoff campaign
(`core/src/monitoring/status.rs:245-291`), but the UI never renders it: `StatusBar.tsx:773`
`staleModifier` and `OpenConnectionsModal.tsx:1338-1347` only branch on `stale`/`offline`.

## Why it matters
When the transport drops, the monitor goes `Live → Stale` (data dims to signal
uncertainty), then the instant reconnect begins it goes `Stale → Reconnecting` — and the
Stale dimming/badge **vanishes**, so the numbers un-dim and read as live again for up to
~151s of cumulative backoff before finally landing on `Offline`. The user is shown fresh-
looking data during the entire retry window when the feed is actually stale. A modeled state
with no UI mapping produces exactly this ambiguous/misleading legibility gap.

## Evidence
- `status.rs:245-291` — backend emits `Reconnecting`.
- `StatusBar.tsx:773` — only `stale` drives dimming; `reconnecting` un-dims.
- `OpenConnectionsModal.tsx:1338-1347` — badge checks `stale`/`offline` only.

## Recommendation
Treat `Reconnecting` at least as visually equivalent to `Stale` (keep dimming + a
"reconnecting" badge/spinner) so data does not un-dim until it is actually live again.
