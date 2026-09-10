---
id: SUP-006
title: The yanked-crate gate reds all PRs on upstream yanks; the mitigation is a recurring manual stopgap
angle: supply-chain
severity: medium
category: workaround
is_workaround: true
subsystem: workspace
evidence:
  - deny.toml:25
  - docs/ci-yanked-crate-runbook.md:1
  - .github/workflows/cargo-update-lockfile.yml:1
status: open
---

## What

`deny.toml` sets `[advisories] yanked = "deny"`, so a **transitive** crate being
yanked from crates.io at any arbitrary time fails the `Security Audit` job on
**every** open PR simultaneously — including PRs that changed no Rust code. This
has recurred repeatedly (chacha20 #2585, der #2636, libssh2-sys #2642 — three
times in one session per the runbook and project memory; also der→libssh2-sys
chains noted in MEMORY). The mitigation is a **weekly** `cargo update` chore
workflow plus a manual runbook to bump the offending crate and reconcile every
open PR.

## Why it matters

The gate itself is correct and should stay (a yank is a genuine withdrawal
signal; the runbook argues persuasively against weakening it). But the current
posture leans on a stopgap: the weekly cadence guarantees a window (up to ~7
days) in which a fresh yank blocks all PR work, resolved only by a human noticing
and running the manual path. It is a recurring tax, and the systemic fix is only
tracked (#2645), not implemented. For release predictability this is a known
recurring source of "all PRs red, no code cause" — the exact failure that wastes
triage time and can be mistaken for a real regression.

The `cargo-update-lockfile.yml` chore also has a self-documented fragility: PRs
opened by the built-in `GITHUB_TOKEN` do not trigger CI (needs a manual
close/reopen or empty commit), and it depends on a repo setting being enabled —
so the "proactive" mitigation can itself silently no-op.

## Evidence

- `deny.toml:21-25` — `yanked = "deny"`, described as "the headline gate".
- `docs/ci-yanked-crate-runbook.md` — the recurrence table and the manual
  5-minute fix path; §"Should the yanked check be a hard gate" records the
  fallback (split the yanked check into its own non-fail-fast job) as *not yet
  adopted*.
- `.github/workflows/cargo-update-lockfile.yml:38-45` — weekly cron + fixed
  automation branch; the runbook notes the `GITHUB_TOKEN`/CI-trigger caveat.

## Recommendation

Implement the runbook's own recorded fallback (the proportionate structural fix):
split the yanked check into a **separate, non-fail-fast** job that is advisory on
PRs but still blocking on the `develop`/`main` push and release lanes. That
removes the "reds every unrelated PR" tax without weakening the release gate —
exactly the trade-off the runbook already reasoned through. Pair it with the
proactive chore (which addresses the churn) so most yanks are cleared before they
surface. Close #2645 with that combination rather than leaving the manual runbook
as the standing answer.
