---
id: TBE2-003
title: "Docker test files added after TBE-006 skip silently even when TERMIHUB_REQUIRE_DOCKER=1 is set"
angle: test-backend
severity: low
category: test-gap
is_workaround: false
subsystem: core/tests docker suites + agent docker nightly lane
evidence:
  - core/tests/support/container.rs:32
  - core/tests/support/container.rs:39
  - core/tests/docker_transfer.rs:184
  - core/tests/docker_remote_copy.rs:171
  - core/tests/docker_symlinks.rs:54
  - core/tests/docker_symlinks.rs:67
  - core/tests/docker_monitoring_fallback.rs:92
  - core/tests/docker_monitoring_fallback.rs:100
  - core/tests/docker_spawn.rs:98
  - core/tests/common/mod.rs:126
  - .github/workflows/integration-fixtures.yml:293
  - .github/workflows/integration-fixtures.yml:318
  - agent/tests/docker_integration.rs:660
  - agent/tests/docker_integration.rs:692
  - .github/workflows/system-integration.yml:748
  - .github/workflows/system-integration.yml:790
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: previous-incomplete
previous_id: TBE-006
---

## What

The TBE-006 fix made `require_docker!` and the fixtures lane's TERMIHUB_REQUIRE_DOCKER=1 turn a missing fixture into a hard failure. Four core test files added afterwards (docker_transfer.rs with 11 tests, docker_remote_copy.rs, docker_symlinks.rs, docker_monitoring_fallback.rs; about 19 Docker-daemon tests, dated 2026-09-26 to 10-01) use their own `client()` / `runtime_client()` helpers. Those helpers return early with `eprintln!("SKIPPED: ...")` when the daemon cannot be reached, an image cannot be pulled or a container cannot be started, and they never consult `runtime_required("TERMIHUB_REQUIRE_DOCKER")`. Only docker_spawn.rs:98 honours it.

The agent Docker nightly job has the same problem: it asserts `docker info`, but each test still skips to green on 'could not start a distroless/alpine container' (docker_integration.rs:660,692). Its comment says 'only the 6 Docker tests run', while 9 are `#[ignore]`d today (7 + 1 + 1), and the job has no count check and no `! grep Skipping` check like the Podman step's.

## Why it matters

The lane that exists to prove Docker-backed transfer, remote-copy, symlink and monitoring behaviour can report green when none of those tests ran, for example when a pull fails, Docker Hub rate-limits, or a daemon is up but its OSType is wrong. This is the false-green class TBE-006 was meant to close, reintroduced by newer tests.

## Recommendation

Route every Docker-daemon helper through one gate. When `runtime_client()` / `client()` fails and `runtime_required("TERMIHUB_REQUIRE_DOCKER")` is set, panic instead of returning. Make an image-pull or container-start failure a failure under the same flag. In system-integration.yml's agent-docker job, set TERMIHUB_REQUIRE_DOCKER=1, make agent `docker_available()` and `start_container` failures honour it, and add a `grep -q 'test result: ok. 9 passed'` / `! grep -q Skipping` check (or a count guard like SERIAL_MIN_TESTS). Correct the stale '6 tests' comment.

## Verification

Confirmed: docker_transfer.rs:184-190 and docker_remote_copy.rs:171-177 `client()` failures, docker_symlinks.rs:54-69 and docker_monitoring_fallback.rs:92-103 skip with eprintln and never consult runtime_required("TERMIHUB_REQUIRE_DOCKER"). Only docker_spawn.rs:98 honours it. The agent-docker job (system-integration.yml:748-790) asserts `docker info`, but agent docker_integration.rs still skips on container-start failure. It has no count or `! grep Skipping` guard, and the comment says 6 tests while 7+1+1=9 are #[ignore]d.

Downgraded because in the fixtures lane Docker is guaranteed up on ubuntu (compose --wait), so the daemon/OSType skip is unlikely. In transfer/remote_copy, ensure_image panics on pull failure (`step.expect`), so the pull-failure false green only applies to symlinks/monitoring/agent. It is a contract gap, not a likely live false green.
