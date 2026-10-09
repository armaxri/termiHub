---
id: MOCK2-001
title: "Rust integration tests ignore dev.local.json: a plain `cargo test` in any slot runs against dev0's fixture ports while its container-control helpers target a container that does not exist"
angle: test-mocking
severity: medium
category: test-isolation
is_workaround: false
subsystem: "core/tests/common, agent/tests (Docker fixture addressing)"
evidence:
  - core/tests/common/mod.rs:496
  - core/tests/common/mod.rs:503
  - core/tests/common/mod.rs:441
  - core/tests/common/mod.rs:594
  - core/tests/common/mod.rs:137
  - core/tests/network_resilience.rs:43
  - core/tests/monitoring_fault.rs:39
  - core/tests/ssh_advanced.rs:591
  - agent/tests/agent_forward_integration.rs:93
  - tests/docker/docker-compose.yml:497
  - tests/system/termihub_harness/dev_local.py:87
  - scripts/internal/dev-local-env.sh:30
  - scripts/internal/dev-local-env.sh:38
  - .claude/CLAUDE.md:415
status: fixed
resolution: "#4338 — termihub_core::test_fixtures resolves ports and container names from env, then dev.local.json, refusing offset 0 in a parallel dev*/termiHub tree; all Rust suites use it"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Rust integration tests find their Docker fixtures only through env vars (`TERMIHUB_TEST_PORT_OFFSET`, `TERMIHUB_TEST_PROJECT`), and only `scripts/internal/dev-local-env.sh` exports those. The repo's documented verification command is a plain `cargo test --workspace --all-features` (.claude/CLAUDE.md:415), which runs with no env set. In that case `resolve_port` falls back to offset 0 (common/mod.rs:503) and the container helpers fall back to project `termihub` (:441, :594). That pair matches no slot. On this machine dev0's containers are `termihub-test-0-*` on offset 0, and slot N's are `termihub-test-N-*` on offset N*1000. So in, say, dev5, `require_docker!` finds dev0's published ports reachable (:137) and runs dev5's SSH/SFTP/telnet suites against dev0's live containers. Meanwhile the helpers that control containers (`apply_fault` / `FaultGuard` via `docker exec termihub-network-fault`, `docker pause` in monitoring_fault.rs:39, the SSH-JUMP-07 bastion restart at ssh_advanced.rs:591) address `termihub-*`containers that do not exist, so those tests fail with`.expect("Fault injection should succeed")`instead of skipping. The Python harness has an explicit guard for exactly this case:`\_guard_silent_collision` (dev_local.py:87) refuses offset 0 in a parallel dev\*/ tree. The Rust side has no equivalent, and no Rust code reads dev.local.json.

## Why it matters

This failure mode looks like a code bug and is not one: cross-checkout failures and red fault-injection tests that agents then try to debug. It also interferes with dev0. Another slot's tests open sessions and write SFTP data against dev0's containers while dev0's own suite runs, and `#[serial(network_fault)]` only serializes within one process, not across checkouts. Even in dev0 a plain run red-fails the fault and bastion tests, because the project name falls back to `termihub` instead of `termihub-test-0`. Per-PR CI does not show this because it has no dev.local.json, so the fallback values happen to match the CI containers.

## Recommendation

Make the Rust resolver match the Python one. In core/tests/common (and the copies in agent/tests and src-tauri remote_exec tests), when the env vars are unset, read `dev.local.json` from the workspace root (`CARGO_MANIFEST_DIR/..`) for `test_port_offset` and `compose_project`. Derive ports and container names from the same source so they can never disagree. Port the `_guard_silent_collision` check: if the checkout sits in a `dev*/termiHub` tree with no dev.local.json and no env, panic with the same message rather than silently using offset 0 / `termihub`. Add a unit test proving that ports and container names resolve from one config.

## Verification

Confirmed. resolve_port (common/mod.rs:497-505) falls back to offset 0, and network_fault_container/fixture_container (:441, :594) fall back to 'termihub'. No Rust test code reads dev.local.json; only dev-local-env.sh exports the env. .claude/CLAUDE.md:415 documents a bare `cargo test --workspace --all-features`. The comment at :488 deliberately treats bare `cargo test` as the 'lone checkout' case, but it has no guard for the parallel dev*/ tree. The Python harness has that guard (\_guard_silent_collision). Slot dev9's dev.local.json uses compose_project termihub-test-9 and offset 9000, so a bare run in a slot hits dev0's ports and targets nonexistent termihub-* containers. Impact is limited to developers and agents, not the product, but this is exactly the silent-collision class the project has repeatedly been burned by.
