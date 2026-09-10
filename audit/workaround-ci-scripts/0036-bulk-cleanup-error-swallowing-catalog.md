---
id: WA-CI-036
title: Catalog — bulk `2>/dev/null || true` error-swallowing across scripts and release codesign
angle: workaround-ci-scripts
severity: info
category: workaround
is_workaround: true
subsystem: scripts
evidence:
  - scripts/smoke-test.sh:90
  - scripts/dev.sh:50
  - scripts/build-agents.sh:302
  - .github/workflows/agent-cleanup.yml:25
status: open
---

## What
Repository-wide sweep of `|| true` / `2>/dev/null || true` in scripts and workflows. The large
majority are **legitimate** best-effort cleanup and probing:
- Process/port/container teardown in trap handlers: `smoke-test.sh` (kill/wait/webdriver_delete),
  `dev.sh:50` (sshd pid kill), `test-system-{linux,mac}.sh` (echo-server/socat/compose down),
  `run-guided-manual.sh` (docker start).
- Optional-tool / capability probes: `build-agents.sh` docker/podman `info` probes, serial-device
  globbing (`ls … 2>/dev/null || true`), `command -v termihub || true`.
- Idempotent release cleanup: `agent-cleanup.yml:25` `gh release delete … || true`.

These are correct uses (a cleanup step should not fail the run). Two `|| true` uses that are
**not** pure cleanup are catalogued separately as their own findings: the macOS codesign signing
steps (WA-CI-018) and the pnpm-audit registry soft-pass (WA-CI-008).

## Why it matters
No defect in the cleanup uses themselves — but `|| true` is a blanket failure-swallow, so this
catalog exists so a reviewer can confirm none hide a *load-bearing* command. The two that do
(codesign, audit soft-pass) are already broken out. `build-agents.sh:316,432` (`write_checksum …
|| true`) is the one borderline case: swallowing a checksum-write failure on a release binary
means the `.sha256` sidecar could be silently missing.

## Evidence
~40 `|| true` occurrences (grep in scripts/ + .github/); cleanup traps in smoke-test.sh (90-97,
236-461), dev.sh (34-98), test-system-*.sh; probes in build-agents.sh (220-238).

## Recommendation
No action for the cleanup/probe uses. Review `write_checksum … || true` (build-agents.sh:316,
432): a failed checksum write on a release agent binary should probably warn loudly or fail,
since `core/build.rs` relies on the `.sha256` sidecar (#1762). Info.
