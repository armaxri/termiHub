---
id: WA-CI-028
title: TERMIHUB_AGENT_SKIP_DOCKER_PROBE env hatch used to speed up CI agent spawns
angle: workaround-ci-scripts
severity: info
category: workaround
is_workaround: true
subsystem: agent/src/handler
evidence:
  - agent/src/handler/dispatch.rs:2066
  - .github/workflows/agent-integration-windows-serial-grade.yml:113
status: open
---

## What
The agent honors `TERMIHUB_AGENT_SKIP_DOCKER_PROBE` (`DOCKER_PROBE_SKIP_ENV`,
dispatch.rs:2066) to skip its Docker-availability probe. The Windows grade lanes set it on each
spawned agent to cut cold-start time (serial-grade comment line 113). It is compiled into the
shipping agent binary and toggled at runtime.

## Why it matters
Another test-only env hatch present in the release binary (same family as WA-CI-027). Low
concern — skipping a capability probe only makes the agent report Docker unavailable — but it is
runtime-toggleable behavior that exists only to serve the test harness, and it silently changes
what backends the agent advertises.

## Evidence
`const DOCKER_PROBE_SKIP_ENV: &str = "TERMIHUB_AGENT_SKIP_DOCKER_PROBE";` (dispatch.rs:2066);
`TERMIHUB_AGENT_SKIP_DOCKER_PROBE=1` per-agent in the grade lanes.

## Recommendation
Acceptable; document it as a test/diagnostic hatch. If a broader audit of `TERMIHUB_*` runtime
hatches is done, group this with WA-CI-027 and decide which belong behind a build feature vs.
plain env. Info.
