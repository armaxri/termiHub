---
id: SUP-004
title: cargo-deny does not gate unmaintained-crate advisories; a known set of abandoned deps ships unmonitored
angle: supply-chain
severity: medium
category: supply-chain
is_workaround: true
subsystem: workspace
evidence:
  - deny.toml:34
  - .github/workflows/code-quality.yml:325
status: open
---

## What

`deny.toml` sets `[advisories] unmaintained = "none"`, so cargo-deny does **not**
fail (or even warn) on RUSTSEC "unmaintained" advisories, and cargo-audit is kept
in agreement (it likewise does not fail on them). The comment acknowledges the
tree carries "a large, tauri-bound set of them (gtk3 bindings, async-std,
proc-macro-error, unic-*, rustls-pemfile, serial, …)".

## Why it matters

Unmaintained is a real supply-chain signal: an abandoned crate will not receive
the *next* CVE fix, and several named here are non-trivial (gtk3 bindings are the
Linux UI substrate; `rustls-pemfile` sits on the TLS trust path; `async-std` is a
full executor). Turning the gate fully off — rather than to `"warn"` — means a
*newly* unmaintained crate (one that becomes abandoned after this decision) also
surfaces nothing, including ones that are **not** in the tracked tauri set and
that a local change could actually act on. The blanket-off setting hides both the
known-unactionable and the future-actionable cases with the same switch.

The stated reason (the tauri-bound set can't be cleared by any local change,
tracked in #1037) justifies not *failing* on them, but not silencing them
entirely.

## Evidence

- `deny.toml:34` — `unmaintained = "none"`.
- `deny.toml:27-33` — comment enumerating the known unmaintained set and
  deferring to #1037.
- `.github/workflows/code-quality.yml:325` — `cargo audit` (no
  `--deny unmaintained`), consistent with the above.

## Recommendation

Switch `unmaintained` from `"none"` to `"warn"` so new/abandoned crates appear in
the CI log without gating PRs, and pair it with an explicit
`[advisories] ignore` list of the *specific* known-unactionable advisory IDs
(the tauri-bound set) so the noise stays suppressed by ID while anything new is
visible. That converts a blanket blind spot into a reviewed allowlist. Keep #1037
as the tracker for actually retiring the gtk3/async-std/etc. deps as tauri's
Linux stack modernizes.
