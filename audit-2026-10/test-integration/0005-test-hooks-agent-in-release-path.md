---
id: TIN2-005
title: "The harness builds the test-hooks agent, which trusts the committed TEST-ONLY signing key, into the canonical release-agent output path"
angle: test-integration
severity: low
category: "test-artifact hygiene / supply chain"
is_workaround: false
subsystem: "scripts/internal/build-system-test-agent.sh"
evidence:
  - scripts/internal/build-system-test-agent.sh:98
  - scripts/internal/build-system-test-agent.sh:143
  - scripts/internal/build-system-test-agent.sh:162
  - scripts/build.sh:90
  - scripts/build.sh:92
  - agent/Cargo.toml:42
  - tests/system/termihub_harness/fixtures.py:1047
status: fixed
resolution: "#4339 — the test-hooks agent builds into target/system-test-agent, never the release-agent path"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

build-system-test-agent.sh builds `--release --target <musl> --features test-hooks` and writes the result to target/<triple>/release/termihub-agent (line 98). That is the same path scripts/build.sh (lines 90-92) and build-agents.sh use for the real agent binaries that developers keep 'ready for upload'. The test-hooks build embeds the TEST-ONLY update-signing key, whose private half is committed, plus env-gated test hatches. The harness triggers this build on its own whenever a deployed-agent suite runs (fixtures.py stage_remote_agent_binary). Nothing on a dev machine marks or isolates the artifact afterwards.

## Why it matters

After a local harness run, the binary at the conventional release path is an agent that accepts updates signed by a publicly known key. A developer who hand-deploys it to a real host through the setup wizard's binary upload, without a rebuild in between, installs an agent that anyone can push a 'signed' update to. Release CI is protected by assert-no-test-signing-key.sh, but local and dev deployments are not.

## Evidence

- `scripts/internal/build-system-test-agent.sh:98`
- `scripts/internal/build-system-test-agent.sh:143`
- `scripts/internal/build-system-test-agent.sh:162`
- `scripts/build.sh:90`
- `scripts/build.sh:92`
- `agent/Cargo.toml:42`
- `tests/system/termihub_harness/fixtures.py:1047`

## Recommendation

Build the test-hooks agent into a dedicated target dir: pass `--target-dir target/system-test-agent` (or set CARGO_TARGET_DIR for the cross build) and point stage_remote_agent_binary at it. It then never shares a path with a normal release agent. Alternatively, copy it out to tests/docker/remote-agent/ and `cargo clean -p termihub-agent --release --target <triple>` afterwards. Optionally, have scripts/build.sh and build-agents.sh run assert-no-test-signing-key.sh on their outputs when no test-hooks features were requested.

## Verification

Confirmed. build-system-test-agent.sh builds with --features test-hooks (through build-agents.sh or cross) into target/$TARGET/release/termihub-agent (line 98). That is the same path scripts/build.sh:90-92 prints for real agents. The script's own probe confirms the output embeds the TEST-ONLY key. docs/release-plan-0.1.0.md:239/313 even tells people to scp target/aarch64-unknown-linux-musl/release/termihub-agent to a device, which makes an accidental hand-deploy plausible. Exploiting it needs a manual deploy without a rebuild, so low.
