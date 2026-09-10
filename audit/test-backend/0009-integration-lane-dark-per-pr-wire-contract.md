---
id: TBE-009
title: Wire-contract and backend behavior are covered only by the dark integration lane, unverified per-PR
angle: test-backend
severity: high
category: test-gap
is_workaround: false
subsystem: core/tests + src-tauri
evidence:
  - .github/workflows/code-quality.yml:88
  - core/tests/common/mod.rs:49
  - src-tauri/tests/sftp_transfer.rs:1
status: open
---

## What
Per-PR CI runs the Rust workspace with integration tests either compile-only
(`cargo test -p termihub-core --no-run`, code-quality.yml:88) or self-skipping (TBE-006). So all
*behavioural* backend coverage — SSH auth/exec/x11/banner/compat, VNC decode + VeNCrypt, FTP
transfer/reconnect/listing, Docker spawn, telnet, tunnels, SFTP transfer, network-resilience —
executes only on the release-cadence integration lane, never on the PR that changes the code.
Critically, a cross-expert finding reports the desktop↔agent **wire-contract rename/delete** param
shapes are broken and "only the dark integration lane would catch" it — i.e. the contract that
routes every projection mutation has no fast, per-PR guardian.

## Why it matters
A per-PR change to a backend or the wire contract merges green while its only real test never ran.
The brief documents three silent app/harness drifts that shipped this way (stale testids, an
undismissable dialog, a Windows bug). For a release, the split means the highest-value tests are
the ones that gate least often. Pure-logic contract shapes (serde (de)serialization of the
rename/delete request/response types) do **not** need Docker and are being left in the dark lane
unnecessarily.

## Evidence
- code-quality.yml:86-93 — integration binaries built `--no-run` per PR.
- common/mod.rs:49-56 — those that do run self-skip without fixtures.
- The 176 integration-test functions vs ~3800 unit — the behavioural mass is in the dark lane.

## Recommendation
Split "needs a live fixture" from "pure contract logic". Move the wire-contract param-shape checks
(serde round-trip of rename/delete/move request+response DTOs, and a mock-transport request/reply
assertion) into **unit** tests that run per-PR — these need no Docker and would have caught the
rename/delete drift. For the genuinely fixture-bound tests, run the nightly integration lane
against every `develop` merge and treat a red nightly as release-blocking, not advisory.
