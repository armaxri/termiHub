---
id: LIBFE-006
title: Roundup — hand-rolled code that should stay hand-rolled (no library warranted)
angle: lib-usage-frontend
severity: info
category: arch
is_workaround: false
subsystem: src (various)
evidence:
  - src/utils/reconnectBackoff.ts:107
  - src/utils/parseHostPort.ts:20
  - src/utils/languageMapping.ts:13
  - src/services/transport/ids.ts:9
  - src/services/transport/ProjectionClient.ts:1
status: open
---

## What

To close the loop on the "buy-vs-build" question: several hand-rolled utilities were
examined and are the **right** call to keep in-house. Recording them so a future
reviewer does not re-open the question or reflexively add a dependency.

- **`reconnectBackoff.ts` (exponential backoff + jitter state machine).** A library
  like `p-retry`/`exponential-backoff` exists, but this is a *pure, timer-free
  reducer* deliberately decoupled from the store's `setTimeout` driver and the SSH
  transport, with domain-specific give-up semantics and injectable RNG for
  determinism. It is thoroughly unit-tested (`reconnectBackoff.test.ts`). A generic
  retry lib would not model the phase machine the UI needs. **Keep.**
- **`parseHostPort.ts` (host:port / IPv6-bracket splitting).** Small, correct,
  IPv6-aware, well-tested. `node:url`/WHATWG `URL` cannot parse a bare `host:port`
  without a scheme, so a parser lib buys nothing. **Keep.**
- **`languageMapping.ts` (filename → Monaco language id).** This is Monaco glue for
  special filenames/dotfiles Monaco itself does not detect (Dockerfile, Jenkinsfile,
  …). `linguist-languages` solves a different problem (GitHub linguist) and would not
  map to Monaco language IDs. **Keep.**
- **`services/transport/ids.ts` + `ProjectionClient.ts`.** Positive examples: these
  already use the right libraries — `ulid` for IDs and `fast-json-patch` for
  projection patching — instead of hand-rolling. LIBFE-001 recommends the rest of the
  app follow `ids.ts`'s lead. **Keep / emulate.**

## Why it matters

The audit's mandate cuts both ways: flagging where a dep should replace hand-rolled
code, *and* recording where hand-rolled is correct so nobody adds a heavy/abandoned
dependency for a domain-specific, well-tested helper. These are the "keep" verdicts.

## Recommendation

No action. Reference this note if a future change proposes pulling in a
retry/URL-parsing/language-detection library for the areas above.
