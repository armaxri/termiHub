---
id: UX-005
title: Sample/seed connection data exists but is never wired into the running app
angle: ux-flows
severity: low
category: ux
is_workaround: true
subsystem: src/store/mockData
evidence:
  - src/store/mockData.ts:3
status: open
---

## What
`src/store/mockData.ts:3-76` defines `MOCK_FOLDERS`, `MOCK_CONNECTIONS` (Local Bash, Local Zsh,
Serial, two Raspberry-Pi SSH hosts, Telnet) and `MOCK_FILES` — exactly the kind of example content
that would jump-start a first-run experience. But a grep for
`MOCK_CONNECTIONS|MOCK_FOLDERS|MOCK_FILES|mockData` across non-test `src/` returns **only the
definitions in `mockData.ts` itself** — there is no production import. It is dead code in
production; new users get zero seed data.

## Why it matters
A ready-made "example connections to explore" experience is built but unused, leaving the first-run
panel genuinely empty (UX-001). This is a missed onboarding lever and dead code that should either
be used or removed before release.

## Evidence
- `mockData.ts:3-76` — mock definitions.
- No production import of these symbols anywhere in `src/` (grep confirms only self-reference).

## Recommendation
Either (a) wire a small set of illustrative, clearly-labelled "example" connections into the
first-run empty state (removable by the user), or (b) delete the dead fixture from production code
and keep it in test-only fixtures. Do not ship unused seed data.
