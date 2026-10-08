---
id: TIN2-003
title: "The harness machinery guards for compose ports and dev-local isolation do not run on PRs that change only tests/docker/ or dev-local-env.sh"
angle: test-integration
severity: low
category: "ci-path-filter gap"
is_workaround: false
subsystem: "scripts/internal/ci-changes.mjs + tests/system machinery suite"
evidence:
  - scripts/internal/ci-changes.mjs:181
  - scripts/internal/ci-changes.mjs:206
  - scripts/internal/ci-changes.mjs:269
  - .github/workflows/code-quality.yml:1370
  - tests/system/tests/test_dev_local.py:122
  - tests/system/tests/test_dev_local.py:155
  - tests/system/tests/test_dev_local.py:167
  - tests/system/tests/test_dev_local.py:215
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The per-PR 'System-Test Harness (machinery)' job runs only when the `harness` area is on (code-quality.yml:1370). ci-changes.mjs maps tests/docker/\*\* to `scripts` only (line 181), and maps scripts/internal/dev-local-env.sh to `scripts` + `frontend`, never `harness`. But the machinery suite's test_dev_local.py is the only gate for the port-isolation invariants, and it reads exactly those files. The relevant tests are test_base_ports_cover_every_compose_published_port, test_every_compose_fixture_port_is_offset_per_checkout, test_compose_fixture_ports_do_not_share_a_host_port and test_python_and_shell_resolvers_agree_on_every_base. They parse tests/docker/docker-compose.yml and dev-local-env.sh.

## Why it matters

These tests were added as regressions for #4004 (RDP published on the base port while the harness probed the offset port), #4007 (two fixtures sharing 2211) and #4094 (FTP passive ranges not offset). A PR that adds a compose service on an un-offset or colliding port touches only tests/docker/, so it skips the machinery job and merges green. The break surfaces post-merge on develop's push run, or as cross-checkout collisions. This is the same mis-classification anti-pattern #3942 fixed for scripts/build-testid-catalog.py.

## Evidence

- `scripts/internal/ci-changes.mjs:181`
- `scripts/internal/ci-changes.mjs:206`
- `scripts/internal/ci-changes.mjs:269`
- `.github/workflows/code-quality.yml:1370`
- `tests/system/tests/test_dev_local.py:122`
- `tests/system/tests/test_dev_local.py:155`
- `tests/system/tests/test_dev_local.py:167`
- `tests/system/tests/test_dev_local.py:215`

## Recommendation

In ci-changes.mjs, also set `harness` for tests/docker/docker-compose.yml (or all of tests/docker/), scripts/internal/dev-local-env.sh, examples/docker/docker-compose.yml and scripts/internal/native-sshd-fixture.\*. Alternatively, add an additive rule like the #3942 one: any file read by a tests/system machinery test also turns on `harness`. Add a ci-changes unit case that pins this.

## Verification

Confirmed. ci-changes.mjs:181 maps tests/docker/ to ['scripts'] only. scripts/internal/dev-local-env.sh gets scripts + frontend through the additive rule but never harness. The machinery job is gated on harness != 'false' (code-quality.yml:1370). test_dev_local.py reads tests/docker/docker-compose.yml (lines 122 and 155) and dev-local-env.sh (lines 44 and 167). integration-fixtures.yml path-triggers on tests/docker/\*\*, but it runs the fixtures and not the test_dev_local machinery tests. A PR that changes only compose can merge with the port invariants untested.
