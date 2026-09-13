---
id: CI-001
title: Integration / reconnect / UI lane is dark on every PR
angle: ci-cd
severity: high
category: test-gap
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/code-quality.yml:261
  - .github/workflows/system-integration.yml:1
  - .github/workflows/system-integration.yml:81
status: open
---

## What
Per-PR CI never runs the integration lane. The only Python-harness step on a PR runs
`-m "not integration"` (`code-quality.yml:261`), so all ~360 `@pytest.mark.integration` tests —
which launch the real desktop app and grade reconnect, layout/scrollback, CSP, terminal flows —
are merely *collected*, never *executed*. The `tests` job (`cargo test --workspace`) also runs with
no Docker up, so every `require_docker!`-gated core integration test self-skips. The real app-launch
lane lives in `system-integration.yml`, which runs **nightly** (develop daily ~05:05 UTC, main
weekly) or on manual dispatch — not per-PR.

## Why it matters
A PR can break the entire app-launch, agent-reconnect, terminal, and UI-integration surface and
still show all-green checks and merge. Detection is deferred up to ~24 h to the nightly, decoupled
from the PR that caused it — exactly the "green PR proves it *collects*, not that it *works*" gap
the workflow header itself calls out (#1568 stale-testid rot shipped this way). For a
safety-critical app whose headline feature is resilient reconnect, the highest-value behavioural
tests do not gate merges.

## Evidence
- `code-quality.yml:261` — `./tests/system/pytest.sh -m "not integration" -q`.
- `system-integration.yml:32-41` — schedule/dispatch only; header (lines 6-15) documents the dark lane.
- `integration-fixtures.yml:25-30` — the Docker core-integration suite only runs per-PR when
  `tests/docker/**`, `core/tests/**`, or `core/src/backends/**` change; any other change that breaks a
  backend's integration path is unexercised on the PR.

## Recommendation
Add a fast, Docker-optional slice of the integration lane to per-PR CI — at minimum the app-launch
smoke + the agent-reconnect UI grade on one OS (Linux headless already works, #2646/#2669) — as a
required check. Keep the full ×3-OS + Docker-fixture matrix nightly. Alternatively gate merges on a
"integration lane green within N hours on the base sha" status. The nightly is a safety net, not a
substitute for a per-PR behavioural gate.
