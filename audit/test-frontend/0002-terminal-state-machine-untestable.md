---
id: TFE-002
title: Terminal connect/reconnect state machine is untestable (logic inside effects, 46% branch)
angle: test-frontend
severity: high
category: test-gap
is_workaround: false
subsystem: components/Terminal/Terminal.tsx
evidence:
  - src/components/Terminal/Terminal.tsx:368
  - src/components/Terminal/Terminal.tsx:1110
  - coverage/clover.xml
status: open
---

## What

`Terminal.tsx` is **1733 lines** and embeds the entire connect/reconnect/attach
state machine directly inside React `useEffect`s (the primary connect effect spans
~lines 368–830; a second create/attach effect ~1110–1560). There is **no pure,
unit-testable module** for the transition logic — the branching over
initial-connect vs. backend-driven reconnect vs. user-initiated reconnect vs.
view-mode vs. agent-connecting is all reached only by mounting the component with
the store, `services/api`, `sessionBridge`, and xterm all mocked.

Committed coverage: **62% line / 46% branch** with 581 statements and 318
conditionals — i.e. **over half the branches in the app's most reliability-critical
component are unexecuted**, and they are precisely the reconnect/error edges.

## Why it matters

Reconnect is the headline reliability feature of the stateless-UI inversion
(#2205/#2139) and this release philosophy is explicitly "ventilator-grade". The
state machine that decides whether a dropped session re-attaches, restarts fresh,
loses scrollback, or lands in an error tab is the least branch-covered code in the
frontend, and it *cannot* be covered efficiently because the transitions are not
extractable without mounting. The many `Terminal.*reconnect*.test.tsx` files exist
but each has to reconstruct a large mock world to nudge one path, which is why
branch coverage plateaus at 46% despite the file count.

The nightly-lane notes already record "optimistic→authoritative id-churn" and
reconnect issues that only surface in integration — consistent with unit tests being
unable to reach these branches.

## Evidence

- `wc -l src/components/Terminal/Terminal.tsx` → 1733.
- `src/components/Terminal/Terminal.tsx:368` and `:1110` — the two large effects that
  hold the connect/reconnect decision tree (comments at :443, :465, :503, :675,
  :1255 enumerate the distinct branches).
- `coverage/clover.xml` → `Terminal.tsx` statements 581 / covered 361 (62%),
  conditionals 318 / covered ~147 (46%).

## Recommendation

Extract the transition logic into a **pure reducer / decision function** that takes
`(currentRegionStatus, tabState, agentState, flags)` and returns an intent
(`attach` | `reconnect-existing` | `fresh` | `view-mode-prompt` | `error`), leaving
the effect to only *apply* the intent. Unit-test the decision function directly with
a table of states — this reaches the 46%→high branch jump cheaply and makes the
reconnect edges regression-proof independent of xterm/DOM. This mirrors the
"systematic layer-elimination" and "domain-migration" patterns already used
elsewhere in the store. Track as a testability refactor; it also unblocks TFE-003.
