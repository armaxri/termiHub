---
id: WA-CI-012
title: cargo-deny suppresses ALL unmaintained-crate advisories (unmaintained = "none")
angle: workaround-ci-scripts
severity: medium
category: supply-chain
is_workaround: true
subsystem: deny.toml
evidence:
  - deny.toml:34
status: open
---

## What
`deny.toml` sets `unmaintained = "none"` (line 34), so cargo-deny does not fail on *any*
unmaintained-crate advisory. The comment explains the tree carries a large tauri-bound set of
them (gtk3 bindings, async-std, proc-macro-error, unic-*, rustls-pemfile, serial, …) that no
local change can clear, tracked for upstream resolution in #1037. cargo-audit is likewise
configured not to fail on unmaintained advisories so the two tools agree.

## Why it matters
Blanket-disabling the unmaintained gate means a *newly* unmaintained crate — including one that
matters, e.g. a crypto or transport dep going unmaintained — will never surface in CI. The
suppression is coarse (all-or-nothing) rather than an explicit allowlist of the known-stuck
crates, so it also masks future additions.

## Evidence
`unmaintained = "none"` with rationale comment (lines 28-34).

## Recommendation
Prefer an explicit per-advisory `ignore = [RUSTSEC-…]` list of the currently-stuck tauri/gtk
advisories over a blanket `none`, so a *new* unmaintained advisory on a load-bearing crate still
reds CI. This turns "we can't act on the gtk churn" into a reviewed allowlist rather than a
disabled gate. Track against #1037 (the tauri/gtk upgrade). Medium — supply-chain visibility on
a pre-release binary.
