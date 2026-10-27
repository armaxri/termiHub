# Runbook: a yanked crate or fresh advisory reds every PR

The `Security Audit` CI job fails on _every_ open pull request — even PRs that
changed no Rust code — in two related situations:

- A **yanked crate** in `Cargo.lock`. The gate is `cargo deny check advisories`
  with `yanked = "deny"` in [`deny.toml`](../deny.toml) — the deliberate guard
  from #2074 against silently shipping a withdrawn dependency. The RDP sidecar's
  own `rdp-sidecar/Cargo.lock` has the same gate
  ([`rdp-sidecar/deny.toml`](../rdp-sidecar/deny.toml)), run by the
  **Security Audit (RDP sidecar)** job (#4357).
- A **freshly-published RUSTSEC advisory** against any dependency. `cargo audit`
  fetches a live advisory DB, so a real vulnerability disclosed upstream flips
  the job red across all open PRs the moment it is published.

Both have happened repeatedly, and both are almost always fixed by a one-line
lockfile bump (or, for a directly-declared crate, a compatible `Cargo.toml`
minimum bump):

| Crate       | Bump            | Reason                        | PR    |
| ----------- | --------------- | ----------------------------- | ----- |
| chacha20    | 0.10.0 → 0.10.2 | yanked                        | #2585 |
| der         | 0.8.0 → 0.8.1   | yanked                        | #2636 |
| libssh2-sys | 0.3.2 → 0.3.3   | yanked                        | #2642 |
| ringbuf     | 0.5.0 → 0.5.2   | RUSTSEC-2026-0293 (real vuln) | —     |

**Real, fixable advisories are bumped, not suppressed.** A RUSTSEC advisory with
an upstream fix (like the ringbuf double-free above) is cleared by upgrading to
the fixed version — never by adding it to the `ignore` list in
[`.cargo/audit.toml`](../.cargo/audit.toml) / [`deny.toml`](../deny.toml). That
ignore list is reserved for non-actionable transitive `unmaintained`/`unsound`
advisories with no fix available (the documented
[accepted risks](supply-chain.md#accepted-risks-rust-advisories-and-pre-release-crates)); putting a
fixable vulnerability there would silently ship it.

The recurrence is the problem: a yank or advisory is published upstream at an
arbitrary time, so the check flips red across all open PRs at once, with no code
change to point at. That looks like a broken PR and is not one.

## Weekly report (no automatic updates)

**No automated job updates dependencies.** Per the maintainer decision of
2026-10-24 (restated 2026-10-26, #5011) no workflow or bot may create a
dependency-update branch or PR, push, or merge. Checks only _report_; the
maintainer decides what to update and lands it by hand with the manual path
below. (The former daily `Cargo Update Lockfile` chore, which opened a lockfile
PR — #2645, #4357, #4465, #4912 — and the Dependabot github-actions config were
removed in #5011.)

The [`Dependency Report`](../.github/workflows/dependency-report.yml) workflow
runs **weekly** (Mondays 06:17 UTC, dispatched on `develop` by
`scheduled-dispatch.yml`) and on demand. With a read-only token, and without
writing anything, it puts into its job summary:

- the compatible updates `cargo update` _would_ make, for `Cargo.lock` and
  `rdp-sidecar/Cargo.lock` (`cargo update --dry-run --verbose`), plus how many
  crates have a newer SemVer-incompatible version;
- `cargo deny check advisories bans licenses sources` for both lockfiles (each
  with its own `deny.toml`);
- outdated npm packages (`pnpm outdated`). npm advisories stay with the Security
  Audit workflow's `pnpm audit` gates.

The run **fails only when something is actionable**: a cargo-deny finding (a
yanked crate, an advisory not on the accepted ignore list, a ban, license or
source violation). Pending updates and outdated packages are information.
Security Audit still audits every `develop`/`main` push and runs daily, so a
yank or advisory surfaces there within a day; the weekly report adds the list
of updates that would clear it.

Run it on demand the moment a yank or advisory is spotted:

```bash
gh workflow run dependency-report.yml --repo armaxri/termiHub --ref develop
```

Notes for a hand-made lockfile update:

- **A pre-release bump reds the tripwire.** If `cargo update` moves a pre-release
  crate (e.g. `rsa 0.10.0-rc.18` → `rc.19`), Rust Code Quality (at "Check
  pre-release crates are reviewed") fails on
  `scripts/internal/check-prerelease-crates.mjs` (SUP-002). That is intended:
  review the bump, then update the exact version in
  `.github/prerelease-allowlist.json` on the same PR.
- **The russh -rc crypto stack is pinned.** `^0.14.0-rc.9` also matches
  `0.14.0`, so `cargo update` moves an -rc crate to its first stable release on
  its own. For `primefield` that broke the build (the -rc `p256`/`p384`/`p521`
  do not compile against 0.14.0), so `core/Cargo.toml` pins `primefield`,
  `aead`, `aes-gcm`, `argon2` and `blake2` with exact `=…-rc.N` requirements
  (#4465). Lift those pins, with their allowlist entries, in a reviewed PR when
  russh moves to a stable RustCrypto line.

## Fast manual fix

When a yank or a fresh advisory reds the PRs (or the weekly report flags one),
do this — it is fast once you know the shape. **Do not** try to debug the failing
PR; the PR is fine.

1. **Identify the crate and whether it is a yank or an advisory.** Run both
   locally — the **full** `cargo deny check` (_not_ advisories-only; the local
   yank cache lags, so the full check refreshes the index) and `cargo audit`
   (which fetches a fresh advisory DB):

   ```bash
   cargo deny check
   cargo audit
   # the RDP sidecar has its own lockfile and configs; run from rdp-sidecar/:
   (cd rdp-sidecar && cargo deny check && cargo audit)
   ```

   `cargo deny` prints `error[yanked]` / "detected yanked crate" for a yank;
   `cargo audit` names the advisory ID, the crate/version, and the fixed version
   (e.g. `RUSTSEC-2026-0293  ringbuf 0.5.0  Upgrade to >=0.5.2`).

2. **Bump just that crate.** For most cases `cargo update` respects the
   `Cargo.toml` constraints, so this is a lockfile-only change — no dependency
   version in `Cargo.toml` moves:

   ```bash
   cargo update -p <crate>
   # e.g. cargo update -p libssh2-sys
   # advisory with a known fixed version:
   cargo update -p ringbuf --precise 0.5.2
   # the same crate in the sidecar lockfile:
   cargo update --manifest-path rdp-sidecar/Cargo.toml -p <crate>
   ```

   If the fixed/non-yanked version is outside the allowed range, widen the
   constraint in the owning `Cargo.toml` (for a directly-declared crate, bump its
   minimum to the fixed version). If no compatible non-yanked/fixed version
   exists at all, it is a genuine upstream problem — file a tracker and raise it.
   **A real, fixable advisory is bumped, never added to the `ignore` list** — see
   the top of this runbook.

3. **Verify green locally, then land that fix first.** Re-run `cargo deny check`
   to confirm it passes, open a small PR with a lowercase conventional subject
   (`fix(deps): bump <crate> off yanked <version>` or
   `chore(deps): update lockfile off yanked <crate>`), and **merge it before**
   the other open PRs. It is the unblocker; everything else waits on it.

4. **Reconcile the other open PRs.** Once the fix is on `develop`, each open PR
   picks up the corrected lockfile by **merging `develop` in** (never rebase,
   per the repo git workflow):

   ```bash
   git fetch origin
   git merge origin/develop   # keep git's default "Merge branch ..." message
   ```

   Their `Security Audit` job then goes green with no per-PR change.

## Should the yanked check be a hard gate or a separate signal?

Recommendation: **keep `yanked = "deny"` as a hard, blocking gate** — do not
downgrade it to a warning.

Rationale:

- A yank is a real supply-chain signal (the author withdrew that exact version,
  often for a soundness or security reason). For a safety-critical app, shipping
  a withdrawn dependency unnoticed is the worse failure mode. The gate exists
  precisely so that cannot happen silently (#2074).
- The pain is **recurrence and simultaneity**, not the gate's strictness. Since
  #3326 Security Audit no longer runs on every PR (a fresh finding surfaces
  post-merge and on the daily lane), the weekly Dependency Report lists the
  pending updates, and the manual path above makes a finding a ~5-minute fix
  rather than a scramble. Weakening the gate would trade a loud,
  actionable signal for a silent risk without removing the underlying churn.
- If the interruption ever becomes intolerable, the
  proportionate step is **not** to weaken the release gate but to split the
  yanked check into its own non-fail-fast job (advisory on PRs, still blocking
  on the `develop`/`main` push and release lanes) so a fresh yank surfaces
  without gating unrelated PR work. That is a larger change with its own
  trade-off (a yank could merge to `develop` before being noticed), so it is
  recorded here as the fallback, not the default.
