---
id: TFE-005
title: God store appStore.ts error/rejection branches ~1/3 untested (66% branch)
angle: test-frontend
severity: high
category: test-gap
is_workaround: false
subsystem: store/appStore.ts
evidence:
  - src/store/appStore.ts
  - coverage/clover.xml
status: open
---

## What

`store/appStore.ts` is the central god store: **2271 statements, 1511 conditionals,
827 methods**. Committed coverage is **82% line / 80% function but only 66% branch**
— roughly **one third of its branches are unexecuted**. Given the store is mostly
straight-line action reducers, the uncovered third concentrates in the
**error/rejection paths, guards, and early-returns** — the `catch` arms, the
"already in-flight" re-entrancy guards, the "session missing / tab gone" bail-outs,
and the optimistic-vs-authoritative reconciliation edges.

There *is* a strong regression suite for one slice of this
(`appStore.storeErrorSurfacing.test.ts` locks in that catch-blocks log + toast rather
than swallow), and ~39 of 92 store test files touch a rejection/`toThrow`/`catch`
path — so this is "thin", not "absent". But the branch number shows the failure-path
coverage is not systematic.

## Why it matters

On a safety-critical release the **failure** behaviour of the store is what protects
the user from a wedged UI: a connect that rejects mid-flight, a reconnect that races
a teardown, a persist that fails, a restore that partially applies. These are exactly
the 34% of branches least likely to be exercised, and they are the ones that produce
"stuck Reconnecting"/silent-data-loss classes of bug this project has already been
bitten by. Happy-path store coverage at 82% lines gives a comfortable headline while
the dangerous third stays dark.

## Evidence

- `coverage/clover.xml` → `appStore.ts` statements 2271/covered 1865 (82%),
  conditionals 1511/covered 992 (**66%**), methods 827/covered 664 (80%).
- 39/92 store test files reference `mockRejected`/`rejects`/`toThrow`/`catch`.

## Recommendation

Drive a **branch-targeted** pass on the store rather than more happy-path tests:
enumerate the `catch` blocks and guard/early-return branches (the coverage HTML
highlights them) and add a test per uncovered failure edge — mock the underlying
`api`/bridge call to reject or return a missing entity, then assert the store lands
in a safe, observable state (logged + toasted where user-facing, no orphaned
in-flight flag, no lost tab). Prioritise the connect/reconnect/restore/persist
actions. Add per-file branch floor for `appStore.ts` (see TFE-011) so this can't
regress.
