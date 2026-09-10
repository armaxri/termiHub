---
id: TFE-006
title: Store slices under-tested — embedded-servers 10%B, tunnel 26%B, plugins 67%B
angle: test-frontend
severity: medium
category: test-gap
is_workaround: false
subsystem: store/slices
evidence:
  - src/store/slices/embedded-serversSlice.ts
  - src/store/slices/tunnelSlice.ts
  - src/store/slices/pluginsSlice.ts
  - coverage/clover.xml
status: open
---

## What

Several Zustand slices carry real feature logic but have weak branch coverage:

| Slice | Line | Branch | Conditionals |
|---|---|---|---|
| `embedded-serversSlice.ts` | 46% | **10%** | 10 |
| `tunnelSlice.ts` | 54% | **26%** | 38 |
| `pluginsSlice.ts` | 91% | 67% | 33 |
| `macrosSlice.ts` | 90% | 73% | 52 |

`embedded-serversSlice` and `tunnelSlice` are the standouts: **90% and 74% of their
branches are unexecuted**. (Note: some tunnel/embedded behaviour is covered
indirectly via `appStore.tunnel-*`, `tunnelSlice.projection`, and
`embeddedServerApi` tests, so the real gap is narrower than 10%/26% — but the slice's
own conditional logic is clearly under-driven.)

## Why it matters

Tunnels and embedded servers are user-facing connection features with their own
error and lifecycle branches (start/stop, failure toast, reachability, delete
re-entrancy). Untested branches here are the same failure-path class as TFE-005 but
in less-scrutinised code. Embedded-server run-location and tunnel-chain logic are
exactly the sort of thing that regresses quietly.

## Evidence

- `coverage/clover.xml` → `embedded-serversSlice.ts` conditionals 10/covered 1 (10%);
  `tunnelSlice.ts` conditionals 38/covered 10 (26%); `pluginsSlice.ts` 33/covered 22
  (67%).

## Recommendation

Add slice-level unit tests that drive each action's branches directly (success,
failure, guard/no-op, and the delete/re-entrancy edges) rather than relying on
incidental coverage through `appStore`. Confirm the real gap after the TFE-001 fix
re-baselines numbers, then set a per-slice branch floor.
