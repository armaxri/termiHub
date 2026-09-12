---
id: LIBFE-005
title: Hand-rolled regex-source parser in regexSafety is largely subsumed by installed scslre
angle: lib-usage-frontend
severity: info
category: security
is_workaround: false
subsystem: src/services/regexSafety
evidence:
  - src/services/regexSafety.ts:88
  - src/services/regexSafety.ts:32
  - src/services/regexSafety.ts:185
status: open
---

## What

`regexSafety.ts` validates user-supplied highlight patterns against ReDoS before
they are compiled and run in the terminal render loop. It layers two detectors:

1. `hasNestedQuantifier(source)` (`regexSafety.ts:88`) — a hand-written, ~80-line
   char-by-char parser of the regex *source* that tracks a stack of group frames,
   skips character classes and escapes, and flags stacked star-height (`(a+)+`).
2. `hasSuperLinearBacktracking(source, flags)` (`regexSafety.ts:185`) — delegates to
   the installed, maintained **`scslre`** finite-automaton ReDoS analyzer, which the
   module's own doc comment says detects "the overlapping-alternation and ambiguity
   shapes the structural check misses."

`scslre` is a real ReDoS analyzer and the classic nested-quantifier shapes that
`hasNestedQuantifier` targets are exactly the shapes an automaton-based analyzer
already reports. So the hand-rolled parser is largely redundant with the library
that runs right after it.

## Why it matters

Recorded as `info` / deliberate keep, but flagged because it is on a
**security-relevant path** and it is exactly the kind of hand-rolled parser this
audit exists to scrutinise:

- **Pro-keep (why it is defensible):** it is cheap defense-in-depth, runs before the
  heavier analyzer, is deterministic, and gives a specific user-facing error message
  ("nested quantifiers"). Removing a layer of protection on a save-time safety gate
  is not something to do lightly on a ventilator-grade release.
- **Pro-simplify:** hand-written regex-source parsers are themselves bug-prone
  (escape handling, character-class edge cases, `{n,}` detection are all subtly
  tricky and are maintained + tested by hand here), and the surface it covers is a
  subset of what `scslre` already proves. Every future regex-syntax nuance is a
  maintenance burden on code the library already handles.

## Evidence

- `src/services/regexSafety.ts:88` — `hasNestedQuantifier` full hand-rolled parser.
- `src/services/regexSafety.ts:32,185` — `import { analyse } from "scslre"` and its use.
- The module doc comment (lines 20–25) itself frames the structural check as a
  heuristic subset of the scslre analysis.

## Recommendation

Keep the layered approach for the release — do **not** rip out the pre-filter under
time pressure. But treat this as a candidate for post-audit simplification: verify
(with the existing `regexSafety.test.ts` corpus) that `scslre` alone catches every
pattern `hasNestedQuantifier` catches; if so, `hasNestedQuantifier` can be demoted to
a thin, well-commented fast-path or removed, reducing hand-maintained
security-relevant parsing. This is the "when the right call may be to keep
hand-rolled" case the audit asked to be documented — the tie-breaker is a test that
proves scslre's coverage is a superset.
