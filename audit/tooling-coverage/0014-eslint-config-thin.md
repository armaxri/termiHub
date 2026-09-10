---
id: TOOL-014
title: ESLint config is thin — no no-console (vs policy), no import-cycle detection
angle: tooling-coverage
severity: medium
category: tooling
is_workaround: false
subsystem: frontend / static-analysis
evidence:
  - eslint.config.js:1
  - .claude/CLAUDE.md:1
status: open
---

## What

The ESLint config is minimal: `eslint:recommended` + `typescript-eslint recommended`
+ `react-hooks recommended` + one `no-unused-vars` tweak, and that is all. Two gaps
matter:

1. **No `no-console` rule** — yet the coding standards say *"never use
   `console.log`/`warn`/`error` for debug output; use `frontendLog`"*. Nothing
   enforces it, so raw `console.*` calls pass lint and can ship.
2. **No import-cycle / import-order detection** — there is no `eslint-plugin-import`
   (or `madge`) check, so circular imports between store/services/components go
   undetected until they cause an initialization-order bug.

There is also no `no-restricted-imports` guarding the design-system rules (the
CLAUDE.md "compose from `src/components/ui/` primitives, tokens only" policy is
entirely convention-enforced).

## Why it matters

Like TOOL-010 for Rust, this is a policy the codebase states but does not enforce,
so the frontend workaround audit is finding `console.*` calls by hand. Import cycles
are a known source of subtle React/Zustand init bugs (the kind the frontend-state
audit chases). A few eslint rules convert these classes into automatic PR failures.

## Evidence

- `eslint.config.js` — 26 lines, only the recommended presets + `no-unused-vars`.
- Policy: `.claude/CLAUDE.md` → "Debugging / Logging" (no `console.*`) and "UI /
  Design System" (compose from primitives, tokens only) — none lint-enforced.

## Recommendation

Extend `eslint.config.js`:

- Add **`no-console`** (`error`, optionally allowing nothing) scoped to `src/**`, so
  the `frontendLog` policy is enforced; whitelist any legitimate boot-time console use
  explicitly.
- Add **`eslint-plugin-import`** with `import/no-cycle` (or run **`madge --circular`**
  in CI) to catch circular dependencies.
- Consider **`no-restricted-imports`** / `no-restricted-syntax` to steer toward the
  `src/components/ui/` primitives and away from raw hex colors, backing the design-
  system policy with a lint rather than review alone.
- Optionally **`eslint-plugin-jsx-a11y`** to support the accessibility audit angle.
