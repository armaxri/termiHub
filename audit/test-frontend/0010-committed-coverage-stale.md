---
id: TFE-010
title: Committed coverage/ report is 6 weeks stale and used as a source of truth
angle: test-frontend
severity: low
category: tooling
is_workaround: false
subsystem: coverage/
evidence:
  - coverage/clover.xml
  - coverage/coverage-final.json
status: open
---

## What

The repository commits a full coverage report under `coverage/` (clover.xml,
coverage-final.json, HTML). The committed artifact is dated **2026-07-30** — roughly 6
weeks old as of this audit. Many test files have been added since (the whole run of
`Terminal.*reconnect*`, agent-disconnect, mutation-cut suites, `App.smoke.test.tsx`,
etc.), so the numbers in it no longer reflect the tree. For example `App.tsx` has a
smoke test but does not appear in the report at all.

## Why it matters

A committed coverage report reads as authoritative but drifts silently — anyone
(including this audit) reaching for it gets a stale picture, and the direction of the
error is unknown (new tests raise coverage; new untested code lowers it). It also
bloats the repo (coverage-final.json is ~5 MB) and, combined with the `.ts`-only
include (TFE-001), the stale headline is doubly misleading.

## Evidence

- `stat` on `coverage/clover.xml` → `Jul 30 01:40 2026`.
- `App.smoke.test.tsx` exists and mounts `App`, yet `App.tsx` is absent from
  `coverage/clover.xml`.

## Recommendation

Do not commit `coverage/` — add it to `.gitignore` and generate it in CI as a
job artifact (or a PR comment). If a committed baseline is desired for the audit,
regenerate it fresh and note the commit/date it reflects. The enforced signal should
be the CI threshold run, not a checked-in snapshot. (Read-only audit — not changing
it here.)
