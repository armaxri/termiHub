---
id: AGT-008
title: Self-update endpoint env-overrides and a live pending-update test hook ship in the release binary
angle: agent-protocol
severity: medium
category: security
is_workaround: true
subsystem: agent/src/update/mod.rs, agent/src/update/test_hook.rs
evidence:
  - agent/src/update/mod.rs:164
  - agent/src/update/test_hook.rs:105
  - agent/src/update/test_hook.rs:164
status: open
---

## What
Two test-only affordances are compiled into the production agent and read from the
environment unconditionally:
1. `TERMIHUB_AGENT_UPDATE_API_URL` / `TERMIHUB_AGENT_UPDATE_ASSET_SUFFIX`
   (`agent/src/update/mod.rs:164`) let the self-update poll be pointed at an
   attacker-controlled "releases/latest" endpoint.
2. `TERMIHUB_AGENT_TEST_PENDING_UPDATE` (+ `..._BINARY`) (`test_hook.rs:105`) can seed a real
   `pending_update` pointing at an arbitrary binary, which then applies on next idle.

An attacker who can set the agent's environment can, via (1), redirect self-update to a
malicious release (and with a matching sidecar defeat the checksum per AGT-005), or via (2)
stage a pending update to an arbitrary real binary — a variant of the AGT-003 RCE that does
not even need RPC access. Safety of (2) is argued only by a non-existent default path
(`test_hook.rs:164`).

## Why it matters
Test scaffolding on a code-execution path should not exist in a safety-critical release
binary. `is_workaround: true` — these should be `cfg`/feature-gated out of release builds.
Env-injection requires prior access, hence medium rather than critical, but the blast
radius (arbitrary code as the agent user) is severe.

## Recommendation
Feature-gate all update test hooks and env-URL overrides so they are absent from release
builds (`#[cfg(feature = "test-hooks")]`), not merely undocumented.
