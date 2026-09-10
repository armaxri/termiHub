---
id: TBE-006
title: require_docker! silently skips (green) so integration tests pass when the fixture is absent
angle: test-backend
severity: high
category: workaround
is_workaround: true
subsystem: core/tests
evidence:
  - core/tests/common/mod.rs:40
  - core/tests/common/mod.rs:49
  - .github/workflows/code-quality.yml:88
status: open
---

## What
Every `core/tests/*` integration test opens with `require_docker!(port)`, which — when the Docker
fixture container is not reachable — prints `SKIPPED: ...` to stderr and `return`s early
(common/mod.rs:49-56). A skipped test **counts as a pass**. In per-PR CI these same tests are only
*compiled* (`cargo test -p termihub-core --no-run`, code-quality.yml:88-93) and never executed at
all; on any lane where the containers are not up they self-skip to green.

## Why it matters
This is a systemic false-confidence pattern: the entire SSH/VNC/FTP/telnet/Docker/monitoring
integration suite (~30 test files, the bulk of the 176 integration tests) can be "green" while
having executed **zero assertions**. A regression in these paths does not turn CI red unless the
run happens on a fully-provisioned host — which per-PR CI never is. The brief notes app/harness
drift has shipped silently three times through exactly this dark lane. A runtime-skip that reports
success is indistinguishable from a real pass in the CI summary.

## Evidence
- common/mod.rs:40-58 — `require_docker!` prints SKIPPED and `return`s (silent green skip).
- code-quality.yml:86-93 — per-PR runs `--no-run` (compile only) for core integration binaries.
- The skip convention is deliberate (comment at mod.rs:38-39: "runtime check instead of #[ignore]")
  — which is precisely why it evades an `#[ignore]` audit and any "N ignored" CI counter.

## Recommendation
Make skips visible and gated: emit a distinguishable "SKIPPED (no fixture)" count and **fail** the
integration lane if the expected fixtures are absent (so a mis-provisioned nightly run reds instead
of green-skipping). Consider `#[ignore]` + an explicit `--include-ignored` fixture lane so skips
are countable, or a required env (`TERMIHUB_REQUIRE_FIXTURES=1`) that turns a skip into a failure
on the integration runner. The current pattern hides both "fixture down" and "test would have
failed" behind the same green.
