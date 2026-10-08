---
id: WA-CI2-005
title: "Frontend lint warnings never fail CI (no --max-warnings 0); react-hooks/exhaustive-deps is warn-level"
angle: workaround-ci-scripts
severity: low
category: suppressed-lint
is_workaround: false
subsystem: ci/frontend-quality
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - package.json:15
  - package.json:116
  - .github/workflows/code-quality.yml:422
  - eslint.config.js:12-21
status: open
resolution: ""
---

## What

`pnpm run lint` is `eslint src/` with no `--max-warnings 0`, and that is what the Frontend Code Quality job runs. The config spreads `reactHooks.configs.recommended.rules` (eslint-plugin-react-hooks 5.2.0), whose `exhaustive-deps` rule is severity `warn`. Any warning, from that rule or a future plugin's recommended set, exits 0. A local read-only run today reports 0 errors and 0 warnings, so this is latent.

## Why it matters

exhaustive-deps catches stale-closure bugs (missing effect dependencies), a real React defect class. The 53 existing `eslint-disable` lines show the rule is treated as binding, yet a new violation only prints and passes. A green Frontend Code Quality does not prove the hooks rule held, and warnings will accumulate unnoticed.

## Recommendation

Change the script to `eslint src/ --max-warnings 0`, or set `"react-hooks/exhaustive-deps": "error"` explicitly in eslint.config.js. The tree is clean today, so either change lands at zero cost.

## Verification

Confirmed. package.json:15 is `eslint src/` with no --max-warnings, and that is what code-quality.yml:422 runs. eslint.config.js spreads reactHooks.configs.recommended.rules, where exhaustive-deps is warn-level, and nothing overrides it to error. WA-FE-011 resolved the existing suppressions but did not make new violations fail. Latent, because the tree is clean today.
