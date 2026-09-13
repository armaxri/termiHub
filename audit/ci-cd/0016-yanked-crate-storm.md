---
id: CI-016
title: Yanked-crate cargo-deny gate reds all PRs; mitigations are reactive
angle: ci-cd
severity: medium
category: supply-chain
is_workaround: false
subsystem: .github/workflows
evidence:
  - .github/workflows/code-quality.yml:343
  - .github/workflows/cargo-update-lockfile.yml:1
  - docs/ci-yanked-crate-runbook.md:1
status: open
---

## What
`cargo deny check advisories bans licenses sources` (`code-quality.yml:343-344`, `yanked = "deny"`)
runs on every PR and in the `security-audit` job. When any **transitive** crate is yanked upstream,
the gate flips red across every open PR at once with no code change on the PR — documented as
recurring three times in one session (chacha20 #2585, der #2636, libssh2-sys #2642). The mitigation
is a weekly `cargo-update-lockfile.yml` chore plus a manual runbook. The runbook (correctly)
recommends keeping the hard gate and not weakening it.

## Why it matters
The gate is right to be blocking (a yank is a real supply-chain signal for a safety-critical app),
but the *operational* cost is high and recurrent, and the mitigation is reactive: a fresh yank
between the weekly chore runs still reds every PR until a human notices, bumps the lockfile, lands it
first, and reconciles every other PR. The systemic fix is tracked (#2645) but the churn is a
standing tax on throughput and a source of "is this red real?" fatigue that erodes gate trust
(compare CI-013).

## Evidence
`code-quality.yml:327-344` (cargo-deny, both jobs run `cargo audit` too — CI-019). The chore
(`cargo-update-lockfile.yml`) is weekly + manual; runbook `docs/ci-yanked-crate-runbook.md` §
"Proactive mitigation" and § "Fast manual fix".

## Recommendation
Adopt the runbook's own recorded fallback if the chore proves insufficient: split the **yanked**
check into its own non-fail-fast job that is advisory on PRs but still blocking on the develop/main
push and release lanes — so a fresh yank surfaces without gating unrelated PR work, while the release
gate stays hard. Increase the `cargo-update` cadence (e.g. daily) to shrink the exposure window. Keep
`yanked = "deny"` blocking on release.
