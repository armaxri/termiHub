---
id: TIN2-004
title: "Quick-start E2E SSH port 2214 collides with the remote-agent-pending-update fixture port 2214, and the collision test does not cover it"
angle: test-integration
severity: low
category: "test-isolation"
is_workaround: false
subsystem: "dev-local port scheme"
evidence:
  - scripts/internal/dev-local-env.sh:87
  - scripts/internal/dev-local-env.sh:91
  - scripts/internal/dev-local-env.sh:66
  - tests/docker/docker-compose.yml:273
  - tests/system/termihub_harness/dev_local.py:160
  - examples/docker/docker-compose.yml:8
  - tests/system/tests/test_dev_local.py:215
  - docs/testing.md:1819
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

dev-local-env.sh:87-91 publishes the examples/docker quick-start SSH target at base 2214. Its comment says this sits 'just past the SSH cluster (2201-2213)'. Since #1520, 2214 is also TERMIHUB_TEST_REMOTE_AGENT_PENDING_PORT (tests/docker/docker-compose.yml:273, dev_local.py:160), and the SSH cluster now runs to 2218. Both ports get the same per-slot offset, so they collide in every checkout, at any offset. test_compose_fixture_ports_do_not_share_a_host_port only expands the tests/docker compose ports. test_dev_local_port_does_not_collide_with_e2e_ssh_port only compares against dev_agent_port, so no test catches this.

## Why it matters

With the quick-start target up (docs/testing.md documents it as a parallel-isolated port), the agent-profile fixtures fail to bind 2214. The reverse also happens. Depending on start order, the deferred-update suites either error or skip. The skip only happens when CI is unset, so local developers see confusing 'fixture unavailable' skips. That undermines the isolation guarantees TIN-016 fixed.

## Evidence

- `scripts/internal/dev-local-env.sh:87`
- `scripts/internal/dev-local-env.sh:91`
- `scripts/internal/dev-local-env.sh:66`
- `tests/docker/docker-compose.yml:273`
- `tests/system/termihub_harness/dev_local.py:160`
- `examples/docker/docker-compose.yml:8`
- `tests/system/tests/test_dev_local.py:215`
- `docs/testing.md:1819`

## Recommendation

Move TERMIHUB_TEST_E2E_SSH_PORT to an unused base, for example 2230 (well clear of the 2201-2218 cluster and the dev_agent_port steps 2222/2232/…). Update examples/docker/docker-compose.yml, docs/testing.md and the stale comment. Extend test_compose_fixture_ports_do_not_share_a_host_port, or add a new test, to include every \_thdl_port base from dev-local-env.sh, so shell-only ports are collision-checked too.

## Verification

Confirmed. dev-local-env.sh sets both TERMIHUB_TEST_REMOTE_AGENT_PENDING_PORT and TERMIHUB_TEST_E2E_SSH_PORT to base 2214, and both get the same offset. tests/docker compose:273 and examples/docker compose:8 both publish 2214. The comment saying 'just past the SSH cluster (2201-2213)' is stale; audit 0033 shows 2214 was picked for E2E before #1520 reused it. The collision test expands only the tests/docker compose port defaults, so the shell-only E2E port is never checked. Severity is low because the quick-start target is opt-in.
