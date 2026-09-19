---
id: CI-020
title: Reconnect grade skipped on Windows; fixture suites self-skip on macOS/Windows
angle: ci-cd
severity: medium
category: test-gap
is_workaround: true
subsystem: .github/workflows/system-integration.yml
evidence:
  - .github/workflows/system-integration.yml:145
  - .github/workflows/system-integration.yml:258
  - .github/workflows/integration-fixtures.yml:74
status: open
---

## What
The one lane that runs real integration behaviour has large per-platform holes:

- **`test_agent_reconnect_ui` is skipped on Windows** — `TERMIHUB_LIVE_AGENT` is set only on macOS
  and ubuntu (`system-integration.yml:145`, `:414`), because "its loopback sshd is unreliable". So
  the safety-critical reconnect grade never runs on Windows in CI.
- **All Docker-fixture suites self-skip on macOS and Windows** — the hosted mac/Windows runners have
  no Linux Docker daemon (`:258-259`, header `:16-27`), so SSH/telnet/serial/agent fixture-backed
  suites only ever run on the Linux leg.
- **`integration-fixtures.yml` has `#[ignore]`d tests** for fixture-content gaps (#864, `:74`).

## Why it matters
Compounded with CI-001 (this lane is nightly-only) and CI-002 (`--reruns 4`), the *effective*
automated integration coverage on Windows is: no reconnect grade, no fixture-backed connection tests.
Windows is a first-class shipped platform; its connection/reconnect behaviour is graded almost
entirely by manual testing and the quarantined unit lane (CI-006). macOS lacks the Docker-fixture
connection coverage too. These are honest, documented skips — but they mean the platform matrix is
far thinner than "runs on all three OSes" suggests.

## Evidence
`:145` (`TERMIHUB_LIVE_AGENT` gated off Windows); `:258-259` (Docker Linux-only); header note
`:20-27`; `integration-fixtures.yml:65-75` (`--test-threads=1` + `#[ignore]` for #864).

## Recommendation
Close the Windows reconnect gap: stand up a reliable loopback sshd on the Windows runner (or a
container/WSL sshd) so `test_agent_reconnect_ui` runs there, or add an alternative Windows reconnect
grade. Provide a Linux-container path for the fixture suites on macOS/Windows (e.g. a remote Docker
host or a lightweight in-process fixture) so connection coverage is not Linux-exclusive. Track and
close the #864 ignored-fixture tests.
