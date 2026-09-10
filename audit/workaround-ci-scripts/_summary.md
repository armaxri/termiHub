# Workaround hunt — CI, scripts & configuration

Angle owner for the **infra/config/scripts** surface: `.github/**` (workflows + actions),
`scripts/**`, and all build/lint/supply-chain config (`Cargo.toml`s, `deny.toml`,
`.cargo/**`, `package.json`, `vite`/`vitest`/`eslint`/`tsconfig`/`commitlint`/`markdownlint`
configs, `tauri.conf.json`, `default.dev.local.json`, `.mcp.json`, `.vscode/**`). Read-only pass.

**36 findings.** This surface is, as expected, dense with stopgaps — but most are *documented
and tracked* (issue-referenced in-line). The audit value here is separating the justified,
tracked stopgaps from the ones that must actually be removed before a public release, and
flagging the coverage gaps a green PR hides.

## Gating checks that are actually advisory / masked

The prompt's headline question. Distinct mechanisms where a "check" does not gate:

| # | Mechanism | Where | Gates? |
| --- | --- | --- | --- |
| WA-CI-002 | `continue-on-error` grade lane | agent-integration-windows-serial-grade.yml:72 | No (by design, #2495) |
| WA-CI-009 | `continue-on-error` full-tree pnpm audit | code-quality.yml:311 | No (dev deps only) |
| WA-CI-010 | `continue-on-error` test-inventory report | code-quality.yml:269 | No (advisory) |
| WA-CI-011 | `continue-on-error` cargo-update sanity | cargo-update-lockfile.yml:94 | No (per-PR is authority) |
| WA-CI-025 | per-step `continue-on-error` smoke | release-linux-smoke.yml:202,218 | Enforced by a later gate step |
| WA-CI-004 | integration tests excluded from per-PR | code-quality.yml:261,216 | **Not run at all on PRs** |
| WA-CI-005 | `--reruns 4` flake auto-retry | system-integration.yml:288,352,503 | Gates, but masks flakes |
| WA-CI-006 | `TERMIHUB_WAIT_SCALE=2` timeout inflation | system-integration.yml:344,513 | Gates, but hides latency regressions |
| WA-CI-007 | 3× installer retry | actions/setup-pnpm | Gates, but masks flakiness |
| WA-CI-008 | audit gate soft-passes on registry error | pnpm-audit-prod-gate.sh:95 | Silently skips on outage |
| WA-CI-001 | 16 tests `#[cfg_attr(windows, ignore)]` | agent/tests | **Skipped on Windows** |
| WA-CI-030 | TODO/FIXME/HACK scan warn-only | release-check.sh:155 | No (warns) |

**Count of genuinely non-gating / masked gates: 5 advisory `continue-on-error` steps** (WA-CI-002,
009, 010, 011, plus release-smoke's 2 steps that are backstopped by an enforce gate), **plus 3
coverage skips** (WA-CI-001 Windows quarantine, WA-CI-004 integration-dark-on-PR, WA-CI-023
ignored fixtures tests), **plus 5 flake-masking retries/inflations** (WA-CI-005/006/007/008/021).

## Full catalog

| id | workaround | file | type | tracked? | removal blocker | sev |
| --- | --- | --- | --- | --- | --- | --- |
| WA-CI-001 | Windows agent-integration tests quarantined | agent/tests | test skip | #2495 | Windows cold-start flake root cause | high |
| WA-CI-002 | serial grade lane non-blocking | agent-integration-windows-serial-grade.yml | continue-on-error | #2495 | un-quarantine WA-CI-001 | medium |
| WA-CI-003 | manual grade lane | agent-integration-windows-grade.yml | scaffolding | #2495 | un-quarantine WA-CI-001 | low |
| WA-CI-004 | integration tests dark on per-PR CI | code-quality.yml | test skip | partial | speed/Docker cost; needs release gate | high |
| WA-CI-005 | `--reruns 4` masks flakes | system-integration.yml | retry mask | #2698 | fix underlying races | medium |
| WA-CI-006 | `TERMIHUB_WAIT_SCALE=2` | system-integration.yml | timeout inflation | #2690 | runner contention (#2639) | medium |
| WA-CI-007 | pnpm 3× install retry | actions/setup-pnpm | retry mask | — | upstream action reliability | low |
| WA-CI-008 | audit gate soft-pass on registry error | pnpm-audit-prod-gate.sh | swallow | #2589 | reliable registry / release-branch hard-fail | medium |
| WA-CI-009 | full-tree pnpm audit advisory | code-quality.yml | continue-on-error | — | upstream dev-dep patches | low |
| WA-CI-010 | test-inventory advisory | code-quality.yml | continue-on-error | #1950 | none (intended) | info |
| WA-CI-011 | cargo-update sanity non-blocking | cargo-update-lockfile.yml | continue-on-error | #2645 | none (intended) | info |
| WA-CI-012 | unmaintained advisories all suppressed | deny.toml | suppressed gate | #1037 | tauri/gtk upgrade | medium |
| WA-CI-013 | RUSTSEC-2023-0071 ignored | deny.toml, .cargo/audit.toml | suppressed advisory | #1037 | russh off vulnerable rsa | medium |
| WA-CI-014 | pre-release RustCrypto + wildcards allow | deny.toml | supply-chain signoff | #1037/#2074 | russh stable release | medium |
| WA-CI-015 | HTTP/2 disabled for crates.io | .cargo/config.toml | net workaround | #897 | crates.io CDN stability | low |
| WA-CI-016 | clippy toolchain pinned 1.98.0 | code-quality.yml | frozen pin | #2549 | periodic bump chore | low |
| WA-CI-017 | setup-uv pinned 0.11.29 | code-quality/system-integration | frozen pin | #1552 | GH Releases API flake | low |
| WA-CI-018 | macOS ad-hoc codesign + `\|\| true` | release.yml, dev-build.yml | unsigned release | #480/#2650 | Developer ID + notarization | high |
| WA-CI-019 | cross-rs `curl\|sudo tar` from latest | agent.yml | unpinned fetch | #2056 | pin + checksum | medium |
| WA-CI-020 | pnpm.overrides transitive pins | package.json | version override | — | upstream deps catching up | low |
| WA-CI-021 | vitest testTimeout 15s | vitest.config.ts | timeout inflation | #1025 | Windows setup speed | low |
| WA-CI-022 | coverage floors below measured | vitest.config.ts | ratchet | #2066 | raise over time | info |
| WA-CI-023 | ignored core integration tests | integration-fixtures.yml, docker/mod.rs | test skip | #864 | fixture content + hosts | medium |
| WA-CI-024 | fixtures lane path-filtered on PR | integration-fixtures.yml | scope narrowing | — | release gate | low |
| WA-CI-025 | release-smoke steps continue-on-error | release-linux-smoke.yml | leftover advisory | #2646/#2669 | cleanup dead branch | low |
| WA-CI-026 | markdownlint 6 rules disabled | .markdownlint.json | suppressed lints | — | doc cleanup | low |
| WA-CI-027 | test-bridge scaffolding in release binary | test_bridge.rs, lib.rs | env-gated scaffolding | #801/#2476 | build-feature gate | low |
| WA-CI-028 | AGENT_SKIP_DOCKER_PROBE env hatch | dispatch.rs | env hatch | — | document/gate | info |
| WA-CI-029 | release-check + dev scripts not CI-run | scripts/** | unverified scripts | — | add CI exercise | medium |
| WA-CI-030 | TODO/FIXME/HACK scan warn-only | release-check.sh | non-gating | — | make hard gate | low |
| WA-CI-031 | `@ts-expect-error` process global | vite.config.ts | suppressed type | — | add @types/node | info |
| WA-CI-032 | shellcheck disables on non-CI scripts | build-agents.sh, pnpm-audit-gate.sh | suppressed lint | — | run scripts in CI | low |
| WA-CI-033 | template ships colliding dev_agent_port 2222 | default.dev.local.json | config foot-gun | #1536 | change template default | info |
| WA-CI-034 | actions on floating tags, not SHAs | .github/** | supply-chain | — | pin to SHA + Dependabot | medium |
| WA-CI-035 | CSP unsafe-inline / wasm-unsafe-eval | tauri.conf.json | security relaxation | — | verify each is required | low |
| WA-CI-036 | bulk `\|\| true` cleanup (catalog) | scripts/** | swallow (mostly OK) | — | review write_checksum only | info |

## Counts by type

- **Advisory / non-gating `continue-on-error`:** 5 (WA-CI-002, 009, 010, 011, 025)
- **Test skips / quarantines:** 4 (WA-CI-001, 004, 023, + partial 003)
- **Flake-masking (retry / timeout inflation / soft-pass):** 5 (WA-CI-005, 006, 007, 008, 021)
- **Suppressed lints / advisories / gates:** 6 (WA-CI-012, 013, 026, 030, 031, 032)
- **Supply-chain / pinning:** 5 (WA-CI-014, 019, 020, 034, + 015)
- **Frozen version pins (maintenance residue):** 2 (WA-CI-016, 017)
- **Release-packaging stopgaps:** 2 (WA-CI-018, 025)
- **Shipped test scaffolding / env hatches:** 3 (WA-CI-027, 028, 035)
- **Unverified scripts / config foot-guns:** 3 (WA-CI-029, 033, 036)

## Must remove before release (ranked)

1. **WA-CI-018 — macOS ad-hoc/unsigned codesign with `\|\| true` swallow.** Ships an
   unsigned/un-notarized macOS app; signing failures are silently tolerated. Tracked as a
   deliberate v0.1.0 beta decision, but a real GA blocker. Real fix: Developer ID + notarization,
   drop `\|\| true`.
2. **WA-CI-014 — pre-release (`-rc`) RustCrypto crypto stack accepted in deny.toml.** Shipping a
   safety-critical release on RC crypto crates; the only enforced guard is the yanked gate. Real
   fix: land the #1037 russh upgrade onto stable RustCrypto. Also tighten `wildcards = "deny"`.
3. **WA-CI-004 — integration lane dark on per-PR CI.** A green PR does not prove the integration
   path works; this exact gap shipped drift 3× historically. Real fix: gate the release candidate
   on a full integration + fixtures run.
4. **WA-CI-001 — 16 Windows agent-integration tests quarantined.** Zero gating Windows coverage
   on the agent transport path that keeps regressing there. Real fix: #2495 root-cause + un-quarantine.
5. **WA-CI-019 / WA-CI-034 — unpinned supply-chain on the release build path.** `curl\|sudo tar`
   of cross-rs `latest` and all actions on floating tags execute untrusted-by-tag code where
   release artifacts are built/signed. Real fix: pin cross-rs (version+checksum) and pin actions
   to SHAs.
6. **WA-CI-012 / WA-CI-013 — suppressed supply-chain advisories** (blanket unmaintained + rsa
   Marvin). Convert the blanket `unmaintained = "none"` to a reviewed allowlist; retire the rsa
   ignore with the russh upgrade.
7. **WA-CI-029 / WA-CI-030 — the release gate itself is unverified and toothless.**
   `release-check.sh` is run by no CI lane and its TODO/FIXME/HACK scan only warns — so the "no
   workarounds at release" bar is not actually enforced. Real fix: CI-exercise the release
   scripts and make the marker scan a hard gate for the release cut.

Everything else is either a justified, tracked stopgap to step down over time (reruns, wait-scale,
retries, frozen pins, coverage ratchet) or low/info polish (markdownlint, ts-expect-error, CSP
review, template port default). None of those block release on their own, but the flake-masking
cluster (WA-CI-005/006/007/008/021) should be ratcheted down with evidence rather than left
permanent.
