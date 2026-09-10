---
id: WA-CI-020
title: package.json pnpm.overrides force transitive versions to patch advisories
angle: workaround-ci-scripts
severity: low
category: supply-chain
is_workaround: true
subsystem: package.json
evidence:
  - package.json
status: open
---

## What
`package.json` carries a large `pnpm.overrides` block force-resolving transitive dependency
versions: `dompurify`, `markdown-it`, `js-yaml`, `serialize-javascript`, `flatted`, `fast-uri`,
`rollup`, `postcss`, `undici`, several `*>picomatch` and `minimatch>brace-expansion` pins. These
override the versions the dependency graph would otherwise resolve, generally to pull in a
patched/advisory-fixed release ahead of the direct dependency updating its own constraint.

## Why it matters
Overrides are a legitimate tool but they are workarounds for upstream lag: each pin masks a
dependency that hasn't yet bumped its own requirement. They rot silently — once the upstream
catches up, a stale override can *hold back* a dependency or conflict, and the block accumulates
entries nobody revisits. There is no comment tying each pin to the advisory/reason it exists.

## Evidence
`pnpm.overrides` in `package.json` (dompurify, markdown-it, js-yaml, serialize-javascript,
flatted, fast-uri, rollup, postcss, undici, *>picomatch, minimatch>brace-expansion, …).

## Recommendation
Document each override with the advisory/issue it addresses (a comment or a tracked list), and
periodically prune entries whose upstream has caught up (verified by removing the pin and
re-resolving). Coordinate with the advisory gate (WA-CI-008/009) so an override and its advisory
retire together. Low.
