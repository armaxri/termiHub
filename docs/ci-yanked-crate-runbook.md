# Runbook: a yanked crate or fresh advisory reds every PR

The `Security Audit` CI job fails on _every_ open pull request — even PRs that
changed no Rust code — in two related situations:

- A **yanked crate** in `Cargo.lock`. The gate is `cargo deny check advisories`
  with `yanked = "deny"` in [`deny.toml`](../deny.toml) — the deliberate guard
  from #2074 against silently shipping a withdrawn dependency.
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
advisories with no fix available (a conscious release sign-off, #3054); putting a
fixable vulnerability there would silently ship it.

The recurrence is the problem: a yank or advisory is published upstream at an
arbitrary time, so the check flips red across all open PRs at once, with no code
change to point at. That looks like a broken PR and is not one.

## Proactive mitigation (should catch most of these)

The [`Cargo Update Lockfile`](../.github/workflows/cargo-update-lockfile.yml)
workflow runs `cargo update` **daily** (04:00 UTC) and on demand
(`workflow_dispatch`). It pulls compatible patch/minor bumps — including
off-yanked replacements and freshly-published advisory fixes — into `Cargo.lock`
and opens a single PR against `develop` when the lockfile changed. Keeping the
lockfile current means a freshly-yanked patch or advisory fix is usually already
in `develop` before it can red PRs. The cadence is **daily** (previously weekly;
see #2645): a weekly refresh left every open PR's Security Audit red for up to a
week when an advisory landed mid-week, so daily shrinks that window to ~a day.

Run it on demand the moment a yank or advisory is spotted:

```bash
gh workflow run cargo-update-lockfile.yml --repo armaxri/termiHub
```

Operational notes for that PR:

- **It best-effort enables auto-merge.** After opening the PR the job runs
  `gh pr merge --auto --merge`, so the refresh lands by itself once CI is green —
  **if the repo has auto-merge enabled** (Settings → General → "Allow
  auto-merge"). If that setting is off the command no-ops (swallowed so the chore
  still succeeds) and the PR waits for a human. **Maintainer:** enabling repo
  auto-merge makes this chore fully hands-off.
- **The PR carries the `automation` label** so the coordinator/maintainer can
  spot and merge it fast when auto-merge is unavailable.
- **CI may not start automatically.** A PR opened by the built-in `GITHUB_TOKEN`
  does not trigger other workflows (a GitHub safeguard). If the checks are
  missing, close and reopen the PR (or push an empty commit) to kick CI. The
  repo setting **Settings → Actions → General → "Allow GitHub Actions to create
  and approve pull requests"** must also be enabled for the job to open the PR
  at all.
- **It uses a fixed automation branch** (`chore/cargo-update-lockfile`) that the
  job force-updates each run, so repeated runs refresh the same PR rather than
  piling up new ones. That force-update touches only this bot-owned branch —
  never a human branch, `develop`, or `main`.

## Fast manual fix (when a yank or advisory slips through between runs)

When a yank or a fresh advisory reds the PRs before the daily chore catches it,
do this — it is fast once you know the shape. **Do not** try to debug the failing
PR; the PR is fine.

1. **Identify the crate and whether it is a yank or an advisory.** Run both
   locally — the **full** `cargo deny check` (_not_ advisories-only; the local
   yank cache lags, so the full check refreshes the index) and `cargo audit`
   (which fetches a fresh advisory DB):

   ```bash
   cargo deny check
   cargo audit
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
- The pain is **recurrence and simultaneity**, not the gate's strictness. The
  proactive `cargo update` chore above attacks that directly by keeping the
  lockfile fresh, and the manual path above makes the occasional slip-through a
  ~5-minute fix rather than a scramble. Weakening the gate would trade a loud,
  actionable signal for a silent risk without removing the underlying churn.
- If the interruption ever becomes intolerable despite the chore, the
  proportionate step is **not** to weaken the release gate but to split the
  yanked check into its own non-fail-fast job (advisory on PRs, still blocking
  on the `develop`/`main` push and release lanes) so a fresh yank surfaces
  without gating unrelated PR work. That is a larger change with its own
  trade-off (a yank could merge to `develop` before being noticed), so it is
  recorded here as the fallback, not the default. Revisit only if the chore
  proves insufficient in practice.
