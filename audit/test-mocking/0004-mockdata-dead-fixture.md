---
id: MOCK-004
title: src/store/mockData.ts is a dead, unreferenced fixture that can drift silently from the real connection types
angle: test-mocking
severity: low
category: workaround
is_workaround: true
subsystem: src/store
evidence:
  - src/store/mockData.ts:1
status: open
---

## What
`src/store/mockData.ts` exports `MOCK_FOLDERS`, `MOCK_CONNECTIONS`, and `MOCK_FILES` — sample
connection/folder/file fixtures typed against `ConnectionFolder`, `SavedConnection`,
`FileEntry`. **Nothing imports it** — not production code, not a single test. A repo-wide grep
for `mockData` / `MOCK_CONNECTIONS` / `MOCK_FOLDERS` / `MOCK_FILES` returns only the file
itself.

## Why it matters
- It is dead sample data left in the source tree. It contributes no coverage and cannot: no
  test asserts against it. If it was once a store seed it is now vestigial.
- Because it is typed against the real DTOs but exercised by nothing, it is a **silent-drift**
  trap: it will keep compiling as the surrounding types evolve (it uses only a subset of
  fields), giving a false impression that a realistic fixture exists, while it slowly diverges
  from what a real saved connection actually looks like. If someone later wires it into a test
  or a demo mode, they inherit a stale, partial shape.

## Evidence
- File defines the three fixtures: `src/store/mockData.ts:3,9,78`.
- No importer anywhere in `src/**` (grep `mockData`/`MOCK_CONNECTIONS` → only the definition).

## Recommendation
Delete `src/store/mockData.ts`. If realistic connection fixtures are wanted for tests, derive
them from the same builders/validators the app uses (or a recorded real config export) and
place them under `src/test/` where they are actually imported, so they stay tied to the live
schema and cannot drift unnoticed.
