# Runbook: a yanked transitive crate reds every PR

A **yanked crate** in `Cargo.lock` fails the `Security Audit` CI job on _every_
open pull request, even PRs that changed no Rust code. The gate is
`cargo deny check advisories` with `yanked = "deny"` in
[`deny.toml`](../deny.toml) — the deliberate guard from #2074 against silently
shipping a withdrawn dependency.

This has happened repeatedly, always on a **transitive** crate the project does
not depend on directly, and always fixed by a one-line lockfile bump:

| Crate       | Bump            | PR    |
| ----------- | --------------- | ----- |
| chacha20    | 0.10.0 → 0.10.2 | #2585 |
| der         | 0.8.0 → 0.8.1   | #2636 |
| libssh2-sys | 0.3.2 → 0.3.3   | #2642 |

The recurrence is the problem: a yank is published upstream at an arbitrary
time, so the check flips red across all open PRs at once, with no code change to
point at. That looks like a broken PR and is not one.

## Proactive mitigation (should catch most of these)

The [`Cargo Update Lockfile`](../.github/workflows/cargo-update-lockfile.yml)
workflow runs `cargo update` weekly (Monday 04:00 UTC) and on demand
(`workflow_dispatch`). It pulls compatible patch/minor bumps — including
off-yanked replacements — into `Cargo.lock` and opens a single PR against
`develop` when the lockfile changed. Merging that PR keeps the lockfile current
so a freshly-yanked patch is usually already replaced before it can red PRs.

Run it on demand the moment a yank is spotted:

```bash
gh workflow run cargo-update-lockfile.yml --repo armaxri/termiHub
```

Two operational notes for that PR:

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

## Fast manual fix (when a yank slips through between runs)

When a yank reds the PRs before the weekly chore catches it, do this — it is
fast once you know the shape. **Do not** try to debug the failing PR; the PR is
fine.

1. **Confirm it is a yank, not a real advisory, and find the crate.** Run the
   **full** `cargo deny check` locally — _not_ advisories-only. The local yank
   cache lags, so `cargo deny check advisories` alone can under-report; the full
   check refreshes the index:

   ```bash
   cargo deny check
   ```

   Look for `error[yanked]` / "detected yanked crate" lines — they name the
   crate and version (e.g. `libssh2-sys 0.3.2`).

2. **Bump just that crate in the lockfile.** `cargo update` respects the
   `Cargo.toml` constraints, so this is a lockfile-only change — no dependency
   version in `Cargo.toml` moves:

   ```bash
   cargo update -p <crate>
   # e.g. cargo update -p libssh2-sys
   ```

   If the crate has no non-yanked release inside the allowed range, widen it
   with `--precise <version>` only if a compatible non-yanked version exists;
   otherwise it is a genuine upstream problem — file a tracker and raise it.

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
