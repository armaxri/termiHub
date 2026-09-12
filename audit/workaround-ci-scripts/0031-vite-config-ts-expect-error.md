---
id: WA-CI-031
title: vite.config.ts suppresses a type error on process.env with @ts-expect-error
angle: workaround-ci-scripts
severity: info
category: workaround
is_workaround: true
subsystem: vite.config.ts
evidence:
  - vite.config.ts:7
status: open
---

## What
`vite.config.ts:7` uses `// @ts-expect-error process is a nodejs global` to read
`process.env.TAURI_DEV_HOST` without `@types/node` typing the `process` global in that config's
tsconfig scope.

## Why it matters
A `@ts-expect-error` is a suppressed type check. It is trivial and correct here (process IS a
node global at config-eval time), but it is the config-surface instance of the suppressed-lint
class this audit tracks, and `@ts-expect-error` will itself error if the underlying error ever
disappears (e.g. after adding `@types/node`), which can surprise a future edit.

## Evidence
`// @ts-expect-error process is a nodejs global` (vite.config.ts:7).

## Recommendation
Prefer a typed approach: ensure `@types/node` is in scope for the vite/vitest config tsconfig
and drop the suppression, or use `import process from "node:process"`. Info.
