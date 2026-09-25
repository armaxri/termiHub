# CI/CD pipeline audit — summary

Angle: **CI/CD pipeline as a quality gate.** Scope: `.github/workflows/**`, `.github/actions/**`,
`commitlint.config.js`, referenced scripts, `docs/ci-yanked-crate-runbook.md`. Read-only.

The pipeline is unusually thoughtful for a solo/agent-driven repo — the comments encode hard-won
lessons and most stopgaps are documented and issue-tracked. But as a **release gate for a
safety-critical app** it has real holes: the entire integration/UI/reconnect surface is dark on
every PR, the sole lane that exercises it masks failures with `--reruns 4`, the shipped binaries
are neither checksummed nor signed and are published to the public before they are built, the CI's
own supply chain is unpinned (floating action tags + `curl | tar` of `latest`), and whether any of
these checks actually *block* a merge lives in GitHub branch-protection settings that are not in the
repo and are still being set up (#2644).

## Pipeline map (workflow × trigger × what it gates)

| Workflow | Trigger | What it gates | Blocking? |
| --- | --- | --- | --- |
| `code-quality.yml` | PR + push develop/main | rustfmt, clippy `-D warnings`, per-feature compile, cargo-audit, cargo-deny, ESLint, tsc, prettier, markdownlint, **Rust tests ×3 OS**, frontend vitest (+coverage on ubuntu), py "machinery" suite, pnpm audit, commitlint | Yes (per-PR core gate) |
| `build.yml` | PR | compile-only (`--no-bundle`), trimmed 3-target matrix | Yes |
| `agent.yml` | PR (paths) | cross-build agent (linux musl ×3, win MSVC +tests, macOS ×2) | Yes |
| `agent-integration-windows-serial-grade.yml` | PR (agent paths) | quarantined Win agent tests, **non-blocking** | No (`continue-on-error`) |
| `agent-integration-windows-grade.yml` | manual | quarantine feedback loop | No (manual) |
| `integration-fixtures.yml` | nightly + PR (backend/fixture paths) | core/tests vs live Docker fixtures | Yes only on matching-path PRs |
| `system-integration.yml` | nightly (develop daily, main Wed) + manual | **the integration lane** — real app launch, reconnect/UI grades, Docker fixtures, ×3 OS | Not per-PR; `--reruns 4` |
| `dev-build.yml` | push develop/main | full installers → dev prerelease | post-merge only |
| `release.yml` | tag `v*.*.*` | build+sign+upload installers & agent bins, verify asset set | the release gate |
| `release-linux-smoke.yml` | after Release / manual | x64 AppImage+deb install + headless GUI smoke | enforcing (#2669) |
| `release-linux-arm64-smoke.yml` | after Release / manual | arm64 .deb install + `--version` | enforcing |
| `auto-close-issues.yml` | PR closed | closes `Closes #N` for develop PRs | bookkeeping |
| `cargo-update-lockfile.yml` | weekly + manual | proactive lockfile refresh PR | chore |
| `agent-cleanup.yml` | branch delete | deletes per-branch agent release | cleanup |

## "Not really a gate" inventory (advisory / masked / quarantined / dark)

Everything shipped as a stopgap or that does **not** block a merge:

1. **Dark integration lane** — per-PR runs `-m "not integration"`; ~360 integration tests only *collected* (CI-001).
2. **`--reruns 4`** on the nightly integration + display-grades lanes (Linux & mac/win) masks real regressions (CI-002).
3. **16 Windows live-agent-TCP tests quarantined** `#[cfg_attr(windows, ignore … #2495)]`; PTY flake #2498 (CI-006).
4. **`agent-integration-windows-serial-grade` whole job `continue-on-error: true`** (CI-006).
5. **Coverage-gap report** `continue-on-error` (code-quality.yml:269) (CI-012).
6. **Full-tree pnpm audit** `continue-on-error` (code-quality.yml:311) (CI-012).
7. **cargo-update sanity-check advisories** `continue-on-error` (cargo-update-lockfile.yml:94) (CI-012).
8. **setup-pnpm** retries installer 3× via `continue-on-error` (CI-014).
9. **No Rust coverage gate** at all; frontend coverage only on the ubuntu leg (CI-011).
10. **PR Build is `--no-bundle` + trimmed matrix** — installers never verified pre-merge (CI-015).
11. **`integration-fixtures` `#[ignore]`d tests** for fixture gaps (#864) (referenced in CI-020).
12. **`TERMIHUB_LIVE_AGENT` reconnect grade skipped on Windows**; Docker-fixture suites self-skip on macOS/Windows (CI-020).
13. **`TERMIHUB_WAIT_SCALE=2`** headroom hiding contention timeouts (CI-002).
14. **Unsigned release** (macOS ad-hoc re-sign, Windows unsigned) + **no bundle checksums** (CI-008).
15. **Release-smoke was advisory** while #2646 open (now enforcing) — watch for regressions (CI-015).
16. **Whether checks are *required*** is external branch-protection config, not in-repo (#2644) (CI-017).

## Top risks (ranked)

1. **CI-002 (critical) — `--reruns 4` masks real regressions on the *only* automated reconnect/integration grade**, a safety-critical path. Quarantine-not-retry is the documented-better pattern; here retry is applied lane-wide.
2. **CI-001 (high) — dark integration lane**: a PR can break the entire app-launch / reconnect / UI surface and still merge green; only a nightly (up to 24 h later) catches it.
3. **CI-008 (high) — shipped desktop bundles have no checksums and no real signatures**; the release is published to the public *before* the artifacts are built (CI-007), so users can download an incomplete/unverifiable release of a safety-critical app.
4. **CI-003/CI-004 (high) — CI's own supply chain is unpinned**: every third-party action floats on a tag, and the agent binaries that ship to users are built by `cross` fetched via `curl | tar` from `releases/latest`.
5. **CI-009 (high) — no release version-drift gate**: the tag is trusted verbatim; nothing checks it against `Cargo.toml` / `package.json` / `tauri.conf.json`. `release-check.sh` exists but is not wired into CI.

Plus: CI-013 (Windows whole-workspace flake reds unrelated PRs), CI-017 (required-checks unverifiable in repo), CI-010 (GITHUB_TOKEN not least-privilege), CI-011 (no Rust coverage), CI-016 (yanked-crate storm).

## Finding index

| id | sev | wk | title |
| --- | --- | --- | --- |
| CI-001 | high | ✓ | Dark integration lane — integration/reconnect/UI never run per-PR |
| CI-002 | critical | ✓ | `--reruns 4` masks real regressions on the sole reconnect/integration grade |
| CI-003 | high | | Third-party GitHub Actions are not SHA-pinned |
| CI-004 | high | | `cross` fetched via `curl | tar` from `releases/latest` builds shipped agent binaries |
| CI-005 | medium | | `rust-toolchain@stable` floats across all build/test/release jobs |
| CI-006 | high | ✓ | 16 Windows agent tests quarantined + a non-blocking grade job that never un-quarantines |
| CI-007 | high | | Release is published to the public before its assets are built |
| CI-008 | high | ✓ | Desktop bundles ship with no checksums and no real signatures |
| CI-009 | high | | No release version-drift gate; `release-check.sh` not wired into CI |
| CI-010 | medium | | GITHUB_TOKEN not least-privilege — most workflows omit `permissions:` |
| CI-011 | medium | | No Rust code-coverage gate |
| CI-012 | medium | ✓ | Advisory `continue-on-error` steps that never fail CI |
| CI-013 | high | | Windows leg runs the whole workspace → one flaky suite reds every unrelated PR |
| CI-014 | low | ✓ | setup-pnpm retries the installer 3× via `continue-on-error` |
| CI-015 | medium | ✓ | PR Build is `--no-bundle` + trimmed matrix → installers unverified pre-merge |
| CI-016 | medium | | Yanked-crate storm reds all PRs; mitigations are reactive |
| CI-017 | high | | Required checks / branch protection live outside the repo (unverifiable) |
| CI-018 | low | | auto-close executes PR-head script with `issues: write` |
| CI-019 | low | | `cargo audit` runs twice; redundant CI work |
| CI-020 | medium | ✓ | Reconnect grade skipped on Windows; fixture suites self-skip on mac/Windows |
| CI-021 | low | | dev-build publishes a release even when build jobs fail |
| CI-022 | low | | No SBOM / build provenance / attestation on releases |
