---
id: TFE-004
title: IPC layer api.ts half-untested and assert-on-mock only (no response validation)
angle: test-frontend
severity: medium
category: test-gap
is_workaround: false
subsystem: services/api.ts
evidence:
  - src/services/api.ts:1
  - src/services/api.test.ts:1
  - coverage/clover.xml
status: open
---

## What

`services/api.ts` is the **2472-line frontend↔Tauri IPC surface** — ~73 `invoke(...)`
command wrappers. Committed coverage is **46% line / 48% branch**. `api.test.ts` is
1179 lines with 71 `toHaveBeenCalled*` assertions, i.e. it tests roughly half the
wrappers and does so purely by asserting that `invoke` was called with the expected
command name and args.

Two gaps:
1. **~27 of the 73 command wrappers have no test at all** (branch coverage 48%).
2. Where tested, the assertion is **assert-on-mock**: it checks the *request*
   (`invoke("cmd", {args})`) but never that the wrapper correctly **decodes/validates
   the response** — the `invoke` mock returns a canned value, so any mapping,
   defaulting, or shape assumption on the return side is unverified.

## Why it matters

`api.ts` is the single choke point between the UI and every backend capability
(connections, sessions, transfers, credentials, agents). A wrong argument name, a
renamed command, or a response-shape mismatch here breaks a whole feature. For a
thin IPC layer, asserting request args is legitimate and useful — but leaving half
the commands untested means a typo'd command string or a dropped argument on those
paths ships silently, and the missing response-side assertions mean a backend schema
change (e.g. a field rename in a returned struct) won't be caught by the frontend
suite at all. This pairs badly with the backend integration lane being nightly-only
(per-PR CI never does a live round-trip).

## Evidence

- `wc -l src/services/api.ts` → 2472; `grep -c "invoke(" src/services/api.ts` → 73.
- `src/services/api.test.ts` → 1179 lines, 71 `toHaveBeenCalled*`, all request-side.
- `coverage/clover.xml` → `api.ts` line 46% / branch 48%.

## Recommendation

- Add a test per **untested** command wrapper (at minimum: correct command string +
  argument mapping). A table-driven test over a `{fn, command, args}` list keeps this
  compact.
- For wrappers that transform the response, add **response-side** assertions: have
  the `invoke` mock return a realistic payload and assert the decoded/normalized
  output — this is what catches backend schema drift.
- Consider a shared schema (or generated types) so request/response shapes are
  checked against the Rust side rather than duplicated by hand.
