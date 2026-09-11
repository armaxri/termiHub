---
id: TOOL-002
title: Frontend coverage include glob omits .tsx — components invisible to the gate
angle: tooling-coverage
severity: high
category: tooling
is_workaround: false
subsystem: frontend / coverage
evidence:
  - vitest.config.ts:24
status: fixed
resolution: "#2759 — .tsx glob fixed"
---

## What

The vitest coverage `include` is `["src/**/*.ts"]` — it matches only `.ts` files
and **excludes every `.tsx` file**, i.e. essentially all React components. An
untested `.tsx` component contributes nothing to the coverage denominator, so it
cannot lower the percentage. The gate can stay green while whole components have
zero tests.

## Why it matters

This makes the frontend coverage gate structurally misleading: the number reflects
hooks/utils/store/services (the `.ts` files) but not the component tree, which is a
large fraction of `src/`. "78.5% statements" (the comment's measured baseline) is a
percentage of a denominator that silently excludes the UI. A component can be added
with no test and the ratchet will not notice — defeating the purpose of the gate the
project deliberately added in #2066.

## Evidence

`vitest.config.ts:24`:

```ts
coverage: {
  provider: "v8",
  include: ["src/**/*.ts"],   // <- excludes every .tsx component
  exclude: ["src/test/**", "src/**/*.d.ts", "src/main.tsx"],
  ...
  thresholds: { lines: 75, statements: 74, functions: 70, branches: 67 },
}
```

The `exclude` list even lists `src/main.tsx` as if `.tsx` were included — but the
`include` glob never admits `.tsx` in the first place, so that exclude is inert and
the intent (cover components, skip the entry point) is not achieved.

## Recommendation

Change the include glob to `src/**/*.{ts,tsx}`. Expect the measured percentages to
**drop** once components enter the denominator — that is the blind spot becoming
visible, not a regression. Re-baseline the four thresholds against the new,
honest numbers (keep them a few points below measured, per the existing ratchet
philosophy), then ratchet up over time. Coordinate with TOOL-001 so the unified
number is computed on the corrected glob from day one.
