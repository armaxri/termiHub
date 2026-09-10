---
id: TFE-012
title: No automated accessibility regression net (no axe)
angle: test-frontend
severity: medium
category: test-gap
is_workaround: false
subsystem: test infra / a11y
evidence:
  - package.json
  - src/test/setup.ts
status: open
---

## What

There is **no automated accessibility assertion tooling** in the frontend test suite:
`package.json` has no `jest-axe`, `vitest-axe`, or `axe-core` dependency, and no test
runs an accessibility audit. 55 test files use `getByRole` / `getByLabelText`, but
those are **incidental queries** used to find elements — they are not a11y assertions
and pass whether or not the accessible name/role is correct in a meaningful way. When
a role, label, `aria-*` attribute, or focus behaviour regresses, nothing fails.

## Why it matters

A dedicated accessibility angle (angle 6) audits a11y correctness, but from a
**test-infra** standpoint the gap is that a11y has **no regression net**: even after
the a11y angle fixes issues, they can silently regress because no test locks them in.
For a released desktop app that aims to be broadly usable (keyboard-only operation of
a terminal hub is a real use case), the absence of an automated check means every a11y
fix is a one-time manual verification with no guard.

## Evidence

- `grep -i axe package.json` → no match (the only `axe` hits in the tree are
  substrings in unrelated files).
- 55 `*.test.tsx` files use `getByRole`/`aria`, but purely as selectors.

## Recommendation

- Add `vitest-axe` (or `jest-axe`) and a small shared helper, then run an `axe`
  assertion in the render tests of the highest-traffic components (App shell, Sidebar,
  ConnectionEditor, Settings, dialogs). Even a handful of `expect(await axe(container))
  .toHaveNoViolations()` calls creates a regression net for role/label/contrast-in-DOM
  issues.
- Coordinate the specific violations to target with the accessibility angle's findings
  so the tests lock in exactly what that audit fixes.
