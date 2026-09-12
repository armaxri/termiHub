---
id: DEAD-009
title: src/store/mockData.ts is unreferenced dead sample data
angle: deadcode-flags
severity: low
category: arch
is_workaround: false
subsystem: src/store/mockData.ts
evidence:
  - src/store/mockData.ts
status: fixed
resolution: "already-on-develop — src/store/mockData.ts already deleted by commit f42b9bc9 (delete dead frontend stubs). No PR — verified 2026-09-12"
---

## What
`src/store/mockData.ts` is not imported by any file in the tree — not by app code,
not by tests. It is leftover sample/seed data from early store development.

## Why it matters
Dead module sitting in the store directory; readers assume store files are live and
may wire it back in or maintain it needlessly.

## Evidence
- `grep -rn "mockData" src/ | grep -v "src/store/mockData.ts:"` → no results (zero
  importers, including tests).

## Recommendation
Delete `src/store/mockData.ts`.
