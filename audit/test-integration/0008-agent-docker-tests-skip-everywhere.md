---
id: TIN-008
title: The agent crate's Docker/integration tests self-skip in every CI lane — never run against real Docker
angle: test-integration
severity: medium
category: test-gap
is_workaround: false
subsystem: agent/tests
evidence:
  - agent/tests/docker_integration.rs:4
  - agent/tests/self_update_integration.rs:30
  - .github/workflows/integration-fixtures.yml:604
  - .github/workflows/agent.yml:107
status: open
---

## What

`termihub-agent` has several Docker-gated integration suites —
`docker_integration.rs`, `docker_deferred_update_integration.rs`,
`self_update_integration.rs` — that "skip automatically on systems without
Docker" (`docker_integration.rs:4`; `self_update_integration.rs:30`). No CI lane
brings Docker up for the **agent** crate:

- `integration-fixtures.yml` runs `cargo test -p termihub-core --all-features`
  only (`:604`) — core, not agent.
- `agent.yml`'s `build-windows` runs `cargo test -p termihub-agent -p
  termihub-core --all-features` (`:107`) but stands up **no** Docker fixtures, so
  the agent's Docker tests self-skip.
- `code-quality.yml` "Run Tests" (`cargo test --workspace`) also runs with no
  Docker.
- `system-integration.yml` builds the agent but drives it through the Python
  harness, not these cargo suites.

Result: these agent integration tests **compile everywhere and execute nowhere**
against real Docker.

## Why it matters

- Agent self-update and Docker-session paths are safety-relevant (an agent that
  mis-updates or leaks a container on a remote host is a serious failure), and
  they have working integration tests that simply never run. That is worse than
  having none, because the green suite reads as coverage.
- The `integration-fixtures.yml` path-trigger covers `core/tests/**` and
  `core/src/backends/**` but not `agent/**`, so an agent change gets no
  integration feedback at all.

## Evidence

- `agent/tests/docker_integration.rs:4` — "automatically skipped on systems
  without Docker."
- `integration-fixtures.yml:568-604` — job is `-p termihub-core` only.
- `agent.yml:107` — agent tests run with no compose bring-up.

## Recommendation

- Extend `integration-fixtures.yml` (or add an agent-integration lane) to bring
  up the `agent` compose profile and run `cargo test -p termihub-agent
  --all-features -- --test-threads=1` against it, and add `agent/**` to that
  workflow's `pull_request.paths`.
- Verify the skip is a hard failure when Docker *is* expected (e.g. an env like
  `TERMIHUB_REQUIRE_DOCKER=1` in the lane) so a broken fixture reds the job
  instead of silently skipping — the same rot `integration-fixtures.yml` was
  created to prevent for core (#858).
