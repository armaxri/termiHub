---
id: TBE2-001
title: "Agent-hosted tunnel end-to-end tests run in no CI lane, and a process-global verifier makes the unattended SSH tests order-dependent"
angle: test-backend
severity: medium
category: test-gap
is_workaround: false
subsystem: agent/tunnel + agent/session unattended
evidence:
  - agent/src/tunnel/mod.rs:505
  - agent/src/tunnel/mod.rs:517
  - agent/src/tunnel/mod.rs:536
  - agent/src/tunnel/mod.rs:629
  - agent/src/tunnel/mod.rs:644
  - agent/src/tunnel/mod.rs:767
  - agent/src/tunnel/mod.rs:782
  - .github/workflows/integration-fixtures.yml:267
  - .github/workflows/integration-fixtures.yml:409
  - .github/workflows/integration-fixtures.yml:423
  - agent/src/session/unattended_tests.rs:85
  - agent/src/session/unattended_tests.rs:258
  - agent/src/session/unattended_tests.rs:283
  - core/src/backends/ssh/host_key.rs:166
status: fixed
resolution: "#4288 — tunnel E2E moved to agent/tests/tunnel_integration.rs, run in the fixtures lane under TERMIHUB_REQUIRE_DOCKER=1; unattended tests assert they own the verifier"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

agent/src/tunnel/mod.rs has three end-to-end tests: start_local_forwards_http_over_ssh, the remote (-R) forward test, and start_dynamic_socks_forwards_http_over_ssh. They drive the real agent registry against the `ssh-tunnel-target` fixture (port 2207) and return green with `skipping: ssh-tunnel-target not reachable`. They live in the agent lib test binary. Per-PR CI has no fixtures, and the fixtures lane runs only `-p termihub-core`, plus the named agent binaries `--test agent_forward_integration` and `--test ssh_files_only_integration` (integration-fixtures.yml:267 says the agent profile is omitted). No workflow runs `-p termihub-agent --lib` with the tunnel fixture up, so agent-hosted local, remote and SOCKS forwarding are never exercised against a real SSH server. They also do not honour TERMIHUB_REQUIRE_DOCKER.

Separately, when the fixture is reachable these tests call `set_host_key_verifier(TrustAll)` on the process-wide OnceLock (host_key.rs:166). The five unattended_tests (otp, untrusted-host-key, missing-password, missing-passphrase, key-auth) in the same binary then return green with 'another host-key verifier is registered'. Whether they run therefore depends on test scheduling order.

## Why it matters

Agent-hosted tunnels are a user-facing feature whose only real end-to-end tests never execute, so a regression in the agent's forward or SOCKS path ships with green CI. The order-dependent skip means that wiring the tunnel fixture into a lane would quietly disable the unattended refusal tests, including unattended_untrusted_host_key_is_refused, which is security-relevant.

## Recommendation

Move the three tunnel tests into an agent integration-test binary (e.g. agent/tests/tunnel*integration.rs), or select them with a `tunnel::tests::start*`filter. Run it in the fixtures lane with`--profile network`and TERMIHUB_REQUIRE_DOCKER=1, and have the skip helper panic under that flag. Give the unattended tests their own process (a separate test binary), or make the host-key verifier injectable per connection or task-local in tests, so`install_verifier()` can never lose a race and skip. At minimum, turn the 'another verifier is registered' branch into a panic.

## Verification

Confirmed: the three tunnel tests in agent/src/tunnel/mod.rs (517/629/767) skip on an unreachable port 2207 with no REQUIRE flag. The only lane that runs agent tests with fixtures up (integration-fixtures.yml:409-423) uses `--test agent_forward_integration` and `--test ssh_files_only_integration`, not `--lib`. system-integration brings compose up only for the Python harness, and its only agent cargo test is the --ignored docker job. The tests call set_host_key_verifier(TrustAll) on the process-wide OnceLock (host_key.rs:166), and unattended_tests.rs install_verifier() documents that it returns false and skips when that happens, so the order dependence is real. It is latent today, since the fixture is never up for the lib binary in CI.
