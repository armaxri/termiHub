---
id: TIN2-001
title: "Nightly bridge lane can still silently skip whole suites: strict-fixture mode stops at compose's exit code and there is no skip guard"
angle: test-integration
severity: medium
category: "silent-skip / false-green"
is_workaround: false
subsystem: "tests/system harness fixtures + system-integration.yml"
evidence:
  - tests/system/termihub_harness/fixtures.py:366
  - tests/system/termihub_harness/fixtures.py:852
  - tests/system/termihub_harness/fixtures.py:883
  - tests/system/termihub_harness/fixtures.py:911
  - tests/system/termihub_harness/fixtures.py:233
  - tests/system/termihub_harness/fixtures.py:1074
  - tests/system/conftest.py:463
  - tests/system/conftest.py:429
  - tests/system/conftest.py:482
  - scripts/internal/build-system-test-app.sh:67
  - scripts/internal/build-system-test-app.sh:69
  - scripts/internal/build-system-test-app.sh:4
  - .github/workflows/system-integration.yml:411
  - .github/workflows/system-integration.yml:298
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

\#4103 added a strict mode for CI: when CI is set, a failing `compose` run raises ComposeFixtureFailed so the test errors instead of skipping. That strict mode covers only one case, a non-zero compose exit. Every other way a fixture can fail on a host with a working Linux Docker daemon still raises ContainerRuntimeUnavailable, and every suite turns that into pytest.skip. The cases still skipped: (1) `compose build/up` hits its 300 s timeout (fixtures.py:852). (2) wait*for_banner / wait_for_rdp never sees the server answer (fixtures.py:911, :233). This is what happens when the VNC or RDP server inside a container is broken. (3) The RDP sidecar was not built. build-system-test-app.sh:67-69 turns a missing libasound or a failed sidecar build into a `::warning::`, and conftest.py:463 then skips the whole RDP suite. The nightly lane also has no expected-skip baseline or skip-count assertion. The Python lane has no TERMIHUB_REQUIRE*\* switch like integration-fixtures.yml, windows-ssh-host.yml and wsl-live.yml have. The pre-build step (system-integration.yml:298ff) only pre-builds the profile-less services, so the rdp/vnc/agent images are built cold inside a test under the 300 s compose timeout.

## Why it matters

This is the same false-green pattern the repo has hit twice already. In #4017/#4103, about 100 SSH/telnet/tunnel suites skipped for days as 'fixtures unavailable'. In #4092, every deployed-agent suite skipped every night. The agent-build path was later made strict on timeout (fixtures.py:1074-1080), but the compose timeout and the readiness probes were not, so behaviour is inconsistent. A regression in the RDP sidecar build, or an xrdp/VNC image change that stops the server answering, removes RDP/VNC E2E coverage (TIN-005/TIN-006) without anything going red. The release-candidate gate calls this same lane, so a release can be graded green with those journeys never run.

## Evidence

- `tests/system/termihub_harness/fixtures.py:366`
- `tests/system/termihub_harness/fixtures.py:852`
- `tests/system/termihub_harness/fixtures.py:883`
- `tests/system/termihub_harness/fixtures.py:911`
- `tests/system/termihub_harness/fixtures.py:233`
- `tests/system/termihub_harness/fixtures.py:1074`
- `tests/system/conftest.py:463`
- `tests/system/conftest.py:429`
- `tests/system/conftest.py:482`
- `scripts/internal/build-system-test-app.sh:67`
- `scripts/internal/build-system-test-app.sh:69`
- `scripts/internal/build-system-test-app.sh:4`
- `.github/workflows/system-integration.yml:411`
- `.github/workflows/system-integration.yml:298`

## Recommendation

(a) In strict mode, treat compose TimeoutExpired and readiness-probe timeouts (wait_for_port, wait_for_banner, wait_for_rdp) on a host whose Docker daemon is reachable and Linux as ComposeFixtureFailed. Keep skipping only for 'no runtime' or a non-Linux daemon.

(b) When CI is set, make rdp_fixtures fail on a missing sidecar on Linux. Make build-system-test-app.sh fail the build when the sidecar build fails and libasound is present, instead of only warning.

(c) Add a skip guard to the nightly Linux leg: a conftest pytest_terminal_summary hook, or a post-step over a junit XML, that fails when a skip reason outside a committed allowlist appears, or when the skip count goes above a committed baseline. Mirror the 'fails on a skip' contract in windows-ssh-host.yml.

(d) Pre-build the profile-gated images (rdp, vnc, agent) in the 'Bring up the Docker fixtures' step so a cold build does not race the 300 s in-test timeout.

## Verification

Confirmed. In fixtures.py, \_strict_fixtures only converts a non-zero compose exit into ComposeFixtureFailed. compose TimeoutExpired (around line 852), wait_for_port, wait_for_banner and wait_for_rdp all still raise ContainerRuntimeUnavailable. conftest.py turns that into pytest.skip for VNC and RDP, and skips RDP outright when find_rdp_helper() is None. build-system-test-app.sh:67-69 only emits ::warning:: when libasound is missing or the sidecar build fails. The workflow pre-build step ('Bring up the Docker fixtures') builds only the profile-less services, and rdp_fixtures uses build=True inside the test. I found no skip-count or allowlist guard in conftest (pytest_terminal_summary only prints timing) or in the workflow. This contrasts with the agent-build path, which is strict on timeout. This is a real false-green path on the release gate lane.
