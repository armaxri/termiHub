# termiHub second full-stack audit — 2026-10

A second comprehensive, multi-angle pre-release audit of termiHub, run after the first
audit's backlog ([`audit/`](../audit/), 2026-09, 668 findings) was worked down. Its purpose
is to re-check the tree with a newer model after a large volume of change, and to answer
three questions:

1. What is **new** — defects introduced or never seen by the first audit?
2. What **regressed** — first-audit fixes that later work undid or broke?
3. What is **incomplete** — first-audit findings whose fix missed part of the problem, or
   whose situation materially changed since?

The goal is unchanged from the first audit: surface every gap, defect and workaround so
termiHub can be released _without workarounds_. termiHub is held to a safety-critical
("ventilator-grade") bar, so reconnect, data-safety and gate integrity weigh heaviest.

## Scope and baseline

- **Commit:** `develop` @ `663465d52` (merge of #4271). Auditors worked on a read-only
  checkout; no builds, no tests, no Docker.
- **Angles:** the same 38 expert angles as the first audit (see
  [`AUDIT-PLAN.md`](./AUDIT-PLAN.md)), so results are directly comparable.
- **Result:** 240 confirmed findings — 0 critical, 6 high, 101 medium, 126 low, 7 info;
  23 flagged `is_workaround: true`. 206 are new, 15 are regressions and 19 are incomplete
  (previous-incomplete) first-audit findings. See [`FINDINGS-INDEX.md`](./FINDINGS-INDEX.md) and
  [`RELEASE-BLOCKERS.md`](./RELEASE-BLOCKERS.md).

## Method

1. **Audit.** One expert agent per angle read the tree and reported raw findings. Each read
   the first audit's ledger for its angle first: it spot-checked that fixes still hold
   (a broken one is a `regression`), did not re-report open/deferred/won't-fix items unless
   the situation materially changed (`previous-incomplete`), and otherwise reported `new`
   problems with `path:line` evidence. Documented maintainer decisions (ADRs, the first
   audit's won't-fix/deferred reasons, unsigned beta, English-only beta, native plugins
   default-off) are not reported as defects.
2. **Adversarial verification.** Every raw finding was handed to a separate verifier whose
   job was to _refute_ it: re-read every evidence pointer at the audited commit, look for a
   guard elsewhere, and look for a deliberate decision (ADR, `docs/architecture.md`,
   `audit/FINAL-SUMMARY.md`) that accepts the behaviour. Only findings that survived were
   kept, at the verifier's severity. The verifier's notes are in each file's
   `## Verification` section.
3. **Recording.** Confirmed findings were written one per file, in the first audit's
   schema plus the extra keys below.

All 240 raw findings survived verification. Some findings are restated by more than one
angle (for example the dark scheduled CI lanes appear under ci-cd, tooling-coverage,
test-frontend and workaround-ci-scripts); they are kept per angle so each angle's folder is
complete, and grouped in `RELEASE-BLOCKERS.md`.

## Layout

```text
audit-2026-10/
  README.md            <- this file
  AUDIT-PLAN.md        <- the expert roster + status and counts per angle
  FINDINGS-INDEX.md    <- per-angle table, all high/medium findings, regressions
  RELEASE-BLOCKERS.md  <- ranked release-gating synthesis
  <angle-slug>/
    NNNN-<slug>.md     <- one file per confirmed finding
```

Unlike the first audit there is no per-angle `_summary.md`; the index carries the per-angle
counts.

## Finding file schema

The first audit's schema ([`audit/README.md`](../audit/README.md)), with IDs suffixed `2`
(`SEC2-001`, `WA-RS2-003`) so they never collide with first-audit IDs, and these extra
frontmatter keys:

```yaml
audit: 2026-10
commit: 663465d52
relation: new | regression | previous-incomplete
previous_id: <first-audit ID> # only for regression / previous-incomplete
```

Sections: `## What`, `## Why it matters`, optionally `## Evidence`, `## Recommendation`,
and `## Verification` (the verifier's note). Severity guide and the workaround mandate are
the same as in the first audit.

## Relation to `audit/`

`audit/` stays the ledger for the first audit and its fix status
([`audit/FINAL-SUMMARY.md`](../audit/FINAL-SUMMARY.md)). This folder is a new, independent
ledger; first-audit findings are not re-listed here unless they regressed or were fixed
incompletely, in which case the new finding links back through `previous_id`.

## Run notes

- Recording agents for different angles shared one scratch directory. The observability
  writer's data file was overwritten by the ci-cd writer's before use, so the observability
  folder briefly held copies of CI2-001..007 under OBS2 IDs. The coordinator regenerated
  the seven observability files from the verified observability findings handed to that
  writer; the per-angle counts now match the verification results.
