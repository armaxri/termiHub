---
id: TFE-009
title: Isolated near-zero modules — monacoCustomLanguages 2%B, KeyPathInput 21%B
angle: test-frontend
severity: low
category: test-gap
is_workaround: false
subsystem: src/utils, src/components/Settings
evidence:
  - src/utils/monacoCustomLanguages.ts
  - src/components/Settings/KeyPathInput.tsx
  - coverage/clover.xml
status: open
---

## What

Two isolated modules sit at near-zero branch coverage:

- **`utils/monacoCustomLanguages.ts` — 8% line / 2% branch** (44 conditionals, 1
  covered). Registers custom Monaco tokenizers/languages; almost entirely unexecuted
  because `monaco-editor` is globally mocked in `src/test/setup.ts` and nothing drives
  the registration logic.
- **`components/Settings/KeyPathInput.tsx` — 40% line / 21% branch** (53 conditionals,
  11 covered). The SSH **private-key path** picker used in connection setup —
  security-adjacent input.

## Why it matters

`monacoCustomLanguages` is low user-risk (editor syntax highlighting; a break is
cosmetic) but the 2% figure means the module is essentially unverified and any
refactor is unguarded. `KeyPathInput` is more interesting: it handles the path to a
credential file, and 79% of its branches (validation, browse, error/empty states) are
untested — a security-adjacent input where a wrong-path or silent-empty branch has
real consequence during connection auth.

## Evidence

- `coverage/clover.xml` → `monacoCustomLanguages.ts` conditionals 44/covered 1 (2%);
  `KeyPathInput.tsx` conditionals 53/covered 11 (21%).

## Recommendation

- `KeyPathInput.tsx` (do first): add tests for the path-validation branches, the file
  picker success/cancel, empty/invalid path, and the error display. Verify it never
  silently accepts an empty/invalid key path.
- `monacoCustomLanguages.ts`: either add a focused unit test that drives the
  registration with a light monaco stub that records `register`/`setMonarchTokensProvider`
  calls, or (if genuinely low-value) exclude it from coverage with a one-line
  justification so it stops depressing the branch number opaquely.
