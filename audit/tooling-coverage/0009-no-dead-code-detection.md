---
id: TOOL-009
title: No dead-code / unused-export detection for the frontend
angle: tooling-coverage
severity: low
category: tooling
is_workaround: false
subsystem: frontend / static-analysis
evidence:
  - eslint.config.js:1
  - package.json:15
status: open
---

## What

Nothing detects dead code, unused exports, or unreferenced files in the TypeScript
frontend. ESLint's `@typescript-eslint/no-unused-vars` catches unused *locals* within
a file, but not an exported symbol, component, or module that nothing imports. On the
Rust side the compiler's `dead_code` lint catches unused items but is not elevated to
`-D` for non-`pub` cross-crate cases, and `pub` items are never flagged.

## Why it matters

Dead code accumulates silently across a fast-moving pre-release — orphaned components
left behind by the projection/reducer migration, superseded helpers, unreferenced
types. It inflates the maintenance surface, confuses readers, and (for the frontend)
skews coverage denominators with code that should simply be deleted. A report makes
removal a deliberate, low-risk cleanup before release.

## Evidence

- `eslint.config.js` enables only `eslint:recommended`, `tseslint recommended`,
  `react-hooks recommended`, and a `no-unused-vars` tweak — no unused-export rule.
- No `knip`/`ts-prune`/`madge` in `package.json` devDependencies.

## Recommendation

Adopt **`knip`** (single tool for unused files, exports, and dependencies — it
subsumes TOOL-008's frontend half). Run it advisory first to produce the initial
dead-code list, delete what it finds, then make it blocking. Optionally add `ts-prune`
if a lighter unused-exports-only report is preferred. For Rust, treat `dead_code`
warnings as signal during the pre-release cleanup and remove unreferenced `pub` items
where crate-internal.
