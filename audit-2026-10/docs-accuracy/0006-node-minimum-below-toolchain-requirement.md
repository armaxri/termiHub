---
id: DOC2-006
title: "Documented Node.js minimum (v18+) is below what the toolchain requires (Node 20.19+)"
angle: docs-accuracy
severity: low
category: wrong-prerequisite
is_workaround: false
subsystem: "README / docs/contributing.md"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - README.md:614
  - docs/contributing.md:15
  - docs/contributing.md:18
  - package.json:60-61
  - package.json:126
  - node_modules/vitest/package.json:128-129
  - .github/workflows/code-quality.yml:415
---

## What

README.md:614 and contributing.md:15-18 say Node.js v18 or later, and package.json engines still allows ^18. Direct dependencies exclude Node 18: vitest 4 (^20 || ^22 || >=24), jsdom (^20.19 || ^22.12 || >=24), knip (^20.19), shiki and @shikijs/monaco (>=20), and markdownlint-cli2 (>=20). Every CI job uses Node 22.

## Why it matters

A contributor who follows the prerequisites with Node 18 will get engine errors or broken `pnpm test` and lint runs. The docs describe a configuration that is neither tested nor supported.

## Recommendation

Change the README, contributing.md and package.json `engines.node` to ">=20.19" (or "22 recommended, matching CI"), and consider adding a .nvmrc/.node-version set to 22.

## Verification

Confirmed. README and contributing.md say Node v18+, but vitest's engines field requires ^20 || ^22 || >=24, and CI uses Node 22. One sub-claim is wrong: package.json has no engines field, so it does not 'allow ^18'. The main finding still holds.
