---
id: FES-010
title: useProjectedSessionLifecycle returns a fresh object literal every render (unmemoized), defeating React.memo in terminal-overlay consumers
angle: frontend-state
severity: low
category: perf
is_workaround: false
subsystem: src/store/useSessionLifecycle
evidence:
  - src/store/useSessionLifecycle.ts:180
  - src/store/useSessionLifecycle.ts:58
status: open
---

## What
`useProjectedSessionLifecycle(tabId)` builds and returns a **new object literal on every render**,
without `useMemo` (`useSessionLifecycle.ts:180-191`):

```ts
const p = projected;
return {
  connecting: effectiveConnecting(p),
  reconnecting: effectiveReconnecting(p),
  ...
  exited: effectiveExited(p),
};
```

This is inconsistent with its three sibling hooks in the same family —
`useProjectedSessionLifecycleMaps` (`:264-273`, `useMemo([view])`), `useProjectedWorkflowRun`,
and `useProjectedBroadcast` — which all memoize their derived object. `useSessionAutoReconnect`
(`:58-105`) has the same unmemoized fresh-object return and additionally recomputes
`onReconnectCommandForTabId(tabId)` each render.

## Why it matters
Not a subscription storm (the store selectors elsewhere are clean), but the new identity every
render defeats `React.memo` / `useEffect` / `useMemo` dependency comparisons in any consumer that
holds the returned slice. The consumer here is the per-tab terminal overlay (connecting /
reconnecting / exited state), which then re-renders on every parent render even when the session
state is unchanged — avoidable work on a per-tab hot path. This is the single genuine ref-stability
inconsistency in an otherwise well-memoized store layer.

## Evidence
- `src/store/useSessionLifecycle.ts:180-191` — fresh object literal, no `useMemo`.
- `src/store/useSessionLifecycle.ts:264-273` — sibling hook correctly `useMemo([view])`.
- `src/store/useSessionLifecycle.ts:58-105` — `useSessionAutoReconnect`, same unmemoized pattern.

## Recommendation
Wrap the returned object in `useMemo` keyed on `[projected]` (and the auto-reconnect result on its
real inputs) to match the sibling hooks, so consumers see a stable reference when session state is
unchanged.
