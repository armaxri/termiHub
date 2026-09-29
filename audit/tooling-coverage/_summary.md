# Tooling & Coverage — audit summary

Angle: **tooling-coverage** — dev/quality automation, scripts, and the coverage
tooling that should gate the release. Id prefix `TOOL`. Read-only pass over
`scripts/**`, `package.json`, `vitest.config.ts`, `Cargo.toml`, `.github/workflows/**`,
`docs/testing.md`, `docs/system-test-local-workflow.md`, and `coverage/`.

## The current tooling landscape

termiHub has an unusually **mature script kit for a pre-1.0 project** and a broad CI
surface. What exists and works well:

- **`scripts/` has `.sh` + `.cmd` parity** for the whole developer loop: `setup`,
  `dev`, `build`, `test`, `check`, `format`, `clean`, `release-check`, `smoke-test`,
  plus agent cross-build and system-test orchestration. `check.sh` mirrors CI's
  lint/format/clippy locally; `test.sh` runs frontend + Rust; `release-check.sh` is a
  real, thoughtful readiness gate (version consistency across 5 files, CHANGELOG,
  change-fragment consolidation, TODO scan, git/branch state).
- **CI is broad**: `code-quality.yml` runs Rust clippy (`-D warnings`, pinned
  toolchain), per-feature isolation builds, frontend eslint/tsc/prettier/markdownlint,
  a 3-OS test matrix, the Python harness "machinery" suite, `cargo-audit`,
  `cargo-deny`, `pnpm audit` (prod-blocking + full-tree advisory), and commitlint.
- **Frontend coverage IS gated in CI** (vitest v8 thresholds enforced on the Ubuntu
  leg, `pnpm test:coverage`), with a documented ratchet philosophy (#2066).
- Good hygiene decisions already made: coverage is **gitignored, not committed** (the
  `.gitignore` comment cites #1528 — a committed report went stale on every branch);
  the testid catalog and test-inventory report are likewise regenerated, not diffed.

But the coverage **story stops at the frontend**, and several classes of static
analysis the codebase's own policies imply are simply not wired up.

## The biggest automation gaps (flagship first)

### FLAGSHIP — there is no unified, whole-app coverage number, and no release gate on it (TOOL-001)

The maintainer's explicit ask — *"what tooling gives a full-coverage (frontend +
backend, unified) picture and gates on it before release?"* — currently has **no
answer in the repo**. There is:

- a **frontend** coverage gate (vitest v8, ~75% floors), but its include glob is
  **`src/**/*.ts` — every `.tsx` component is invisible to the percentage** (TOOL-002),
  so the gate under-counts and untested components vanish from the denominator;
- **zero Rust coverage tooling** — no `cargo-llvm-cov`, no `tarpaulin`, no gate, no
  report — even though `docs/testing.md` states a **">80% Rust line coverage" target**
  (TOOL-003). The backend, agent, and core crates (the safety-critical hot path) are
  entirely unmeasured;
- **no combined report or number** spanning both languages, and **nothing published
  from CI** (no artifact upload, no Codecov), so no reviewer or release manager can
  see coverage without running it locally (TOOL-004);
- **integration/system coverage is dark** on the PR lane (nightly-only, and even then
  uninstrumented), which has let real bugs ship three-plus times per the coordinator's
  own record (TOOL-005).

**Concrete design for the flagship capability** — a `scripts/coverage.sh` (+`.cmd`)
plus one CI job that produces a single whole-app number and ratchets it:

1. **Frontend**: `vitest run --coverage` with the include glob fixed to
   `src/**/*.{ts,tsx}`; emit `lcov` (v8 already can). Re-baseline the thresholds after
   the `.tsx` fix (they will drop — that is the blind spot surfacing, not a regression).
2. **Rust**: add `cargo-llvm-cov` (works across the whole workspace incl. `--all-features`,
   integrates with `cargo test` and the Docker integration lane, emits `lcov`). One
   command: `cargo llvm-cov --workspace --all-features --lcov --output-path rust.lcov`.
3. **Merge**: both tools emit **lcov**; merge the two `.lcov` files and compute one
   repo-wide line/branch number (e.g. via `lcov`/`grcov`/a tiny script, or upload both
   flags to Codecov which unifies them). Emit an HTML report as a CI artifact.
4. **Gate**: enforce a **fail-on-decrease ratchet** on the unified number in one CI job
   (start advisory for one cycle to establish the baseline, then make blocking — a
   `continue-on-error` starter, removed on the next PR, is the honest stopgap). Add a
   `coverage` step to `release-check.sh` so the release gate refuses to ship on a drop.
5. **Integration coverage**: run the nightly integration lane under `cargo-llvm-cov`
   too and feed it into the same merge, so the dark lane finally contributes a number.

This is the single highest-leverage tooling investment for the release: it turns
"we think the backend is ~80% covered" into a measured, gated fact and closes the
`.tsx` blind spot that currently lets untested UI pass a green gate.

### Other high-leverage gaps

- **Policy-vs-lint gaps** — the coding standards ban `.unwrap()` in production Rust and
  `console.log` in frontend, but **no lint enforces either** (no `clippy.toml`, no
  `clippy::unwrap_used`; eslint has no `no-console`). These are exactly the classes the
  workaround-rust / workaround-frontend experts are hunting by hand (TOOL-010, TOOL-014).
- **No unused-dependency / dead-code detection** (no `cargo-machete`/`cargo-udeps`, no
  `knip`/`depcheck`) — supply-chain and bloat risk with a zero-config fix (TOOL-008/009).
- **No git hooks** — the only autoformat is a **Claude-specific** `PostToolUse` hook in
  `.claude/settings.json`; a human or non-Claude commit bypasses every local gate, and
  CI is the only backstop (TOOL-007).
- **No single "reproduce CI locally" command** — `check.sh` + `test.sh` + system-test
  are three separate entry points; parity with CI drifts (TOOL-006).
- **Scripts no CI lane executes can rot** — the SC2257/`set -u` lesson: `smoke-test.sh`,
  the `test-system-*.sh` orchestrators, and `run-guided-manual.sh` are host/display-gated
  and never run headless in CI; `.sh`/`.cmd` parity has no drift check (TOOL-012).

## Prioritized list of scripts/tooling to add or extend

| # | Priority | Add / extend | Prevents |
|---|----------|--------------|----------|
| TOOL-001 | **High** | NEW `scripts/coverage.sh` + unified CI coverage job (flagship, above) | ships with unknown backend coverage |
| TOOL-002 | **High** | FIX vitest `include` glob `.ts` → `.ts,tsx` | green gate hiding untested components |
| TOOL-003 | **High** | ADD `cargo-llvm-cov` + Rust coverage gate | unmeasured safety-critical backend |
| TOOL-010 | **Med-High** | ADD `clippy.toml` + `clippy::unwrap_used`/`expect_used` (warn→deny) | `unwrap()` panics on real paths |
| TOOL-004 | **Med** | Publish coverage as a CI artifact / Codecov; delete stale local `coverage/` | invisible coverage; stale local report |
| TOOL-005 | **Med** | Instrument the nightly integration lane; make the coverage-gap report blocking on release | dark per-PR integration coverage |
| TOOL-006 | **Med** | NEW `scripts/ci-local.sh` = check + test + system machinery in one | local/CI parity drift |
| TOOL-007 | **Med** | ADD `lefthook`/`husky` pre-commit (format+lint) + pre-push (test) | non-Claude commits bypass all gates |
| TOOL-008 | **Med** | ADD `cargo-machete` + `knip`/`depcheck` (unused deps) | dependency bloat / supply-chain |
| TOOL-011 | **Med** | EXTEND `release-check.sh`: run coverage, system tests, real bundle build | release gate that skips key checks |
| TOOL-012 | **Med** | CI-execute display-gated scripts headless; add `.sh`/`.cmd` parity drift check | `set -u`/parity rot (SC2257 class) |
| TOOL-014 | **Med** | EXTEND eslint: `no-console`, import-cycle (`eslint-plugin-import`/madge) | console.log leaks; import cycles |
| TOOL-009 | **Low** | ADD `knip` dead-code / unused-export report | dead code accumulation |
| TOOL-013 | **Low** | ADD binary/bundle-size budget check to release lane | silent binary bloat |

## Findings index

- `0001-no-unified-fullapp-coverage-gate.md` — **flagship**: no whole-app coverage number/gate
- `0002-vitest-coverage-excludes-tsx.md` — frontend coverage include glob omits `.tsx`
- `0003-no-rust-coverage-tooling.md` — no llvm-cov/tarpaulin, no Rust gate (docs claim 80%)
- `0004-coverage-not-published-stale-local.md` — coverage never published from CI; stale local dir
- `0005-integration-coverage-dark-per-pr.md` — integration lane uninstrumented + nightly-only
- `0006-no-ci-local-single-command.md` — no one-command local CI reproduction
- `0007-no-git-hooks-only-claude-autoformat.md` — no pre-commit/pre-push hooks
- `0008-no-unused-dependency-detection.md` — no cargo-machete/knip
- `0009-no-dead-code-detection.md` — no unused-export/dead-code report
- `0010-no-clippy-unwrap-lint.md` — no lint enforces the no-unwrap Rust policy
- `0011-release-check-gaps.md` — release-check skips coverage/system-tests/bundle build
- `0012-scripts-not-run-in-ci.md` — display-gated scripts never executed; no sh/cmd parity check
- `0013-no-bundle-size-budget.md` — no binary/bundle-size budget
- `0014-eslint-config-thin.md` — no no-console, no import-cycle detection
