---
id: WA-CI2-003
title: "Bridge-harness fixture readiness timeouts still degrade to a silent pytest.skip under CI strict mode"
angle: workaround-ci-scripts
severity: medium
category: masked-gate
is_workaround: true
subsystem: tests/system harness
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - tests/system/termihub_harness/fixtures.py:852-856
  - tests/system/termihub_harness/fixtures.py:872-886
  - tests/system/termihub_harness/fixtures.py:888-915
  - tests/system/termihub_harness/fixtures.py:211-235
  - tests/system/termihub_harness/fixtures.py:366-372
  - tests/system/conftest.py:287-306
  - .github/workflows/system-integration.yml:411
status: fixed
resolution: "#4315 — compose, readiness-probe and exec timeouts raise ComposeFixtureFailed under CI; TERMIHUB_REQUIRE_FIXTURES backstop"
---

## What

\#4103 added a strict mode (`CI` set) so that a failed `compose up`/`build` raises ComposeFixtureFailed instead of skipping. Three other failure paths still raise ContainerRuntimeUnavailable, which every fixture helper turns into `pytest.skip(...)` (conftest.py:303-305 and ~10 siblings), even under CI: a `compose` subprocess timeout (fixtures.py:852-856, and again at 1074/1254/1334); a container that starts but never opens its port (`wait_for_port`, :883); and a service that never sends its banner or RDP reply (`wait_for_banner` :911, `wait_for_rdp` :233). None of these checks `_strict_fixtures()`. No skip budget or count guard exists in pytest.sh or the conftest session hooks.

## Why it matters

This is the #858 rot class in the bridge harness. A fixture that builds and starts but crash-loops, ships a broken sshd/telnetd config, or hangs on build makes the whole Docker-backed suite (SSH, SFTP, jump-host, VNC, RDP, serial, deployed-agent) skip. The Linux integration leg stays green. The leg runs nightly and inside release-candidate.yml, which the release gate requires, so a release can be certified with those suites never executed. The core/tests lane already closes this with TERMIHUB_REQUIRE_DOCKER=1; the Python lane only half-closed it.

## Recommendation

In strict mode, raise ComposeFixtureFailed (not ContainerRuntimeUnavailable) from the TimeoutExpired branches and from wait_for_port, wait_for_banner and wait_for_rdp. Keep ContainerRuntimeUnavailable only for 'no runtime' and 'non-Linux daemon'. As a backstop, add a CI-only guard (an env such as TERMIHUB_REQUIRE_FIXTURES=1 set on the ubuntu integration step) that fails the session in pytest_sessionfinish if any test skipped with a 'fixtures unavailable' or 'fixture unavailable' reason. Add unit tests to tests/system/tests/test_fixtures.py next to the existing name-conflict strict-mode tests.

## Verification

Confirmed. In fixtures.py, the CalledProcessError path checks \_strict_fixtures(), but the compose TimeoutExpired path (852-856) raises ContainerRuntimeUnavailable unconditionally. So do wait_for_port (883) and wait_for_banner (911). The agent-build timeout (1074-1081) does honour strict mode, which shows the gap is an inconsistency, not a design choice. conftest \_ensure_services turns ContainerRuntimeUnavailable into pytest.skip. pytest_sessionfinish only handles timing and the manual report; there is no skip guard. As a result, a crash-looping or hung fixture on the Linux CI leg skips the suites while the leg stays green.
