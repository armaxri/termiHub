---
id: DUP2-010
title: "Three hand-rolled version parsers sit beside the semver crate; the desktop agent-compatibility check rejects pre-release versions"
angle: code-duplication
severity: low
category: duplication
is_workaround: false
subsystem: "src-tauri/src/utils/version.rs, core/src/protocol/methods.rs, agent/src/update/version.rs"
evidence:
  - src-tauri/src/utils/version.rs:12-22
  - src-tauri/src/utils/version.rs:43-73
  - src-tauri/src/terminal/agent_deploy.rs:92
  - src-tauri/src/commands/agent.rs:903-913
  - core/src/protocol/methods.rs:475-481
  - agent/src/update/version.rs:15-33
  - agent/src/handler/dispatch.rs:626-627
  - core/src/plugin/version_change.rs:139-141
  - .github/workflows/release.yml:242-245
status: fixed
resolution: "#4363 — shared semver-based core::util::version replaces the three parsers; pre-release agents are compatible"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Version comparison is implemented separately in several places. Desktop `parse_semver` uses `split('.')` with exactly three integer parts. Core `parse_protocol_version` is another split-based parser. The agent `update::version::parse_version` and `handler::dispatch` use the `semver` crate, and `core::plugin::version_change::parse_version` uses semver as well. The desktop parser returns `InvalidVersion` for any pre-release or build-metadata string: `0.2.0-beta.1` splits into four parts. Release CI explicitly supports `vX.Y.Z-beta.N` tags, and the verify-version step forces Cargo versions to match the tag, so the agent then reports `termihub-agent 0.2.0-beta.1`.

## Why it matters

Today the only caller of `is_version_compatible` is the `probe_remote_agent` command, which has no frontend caller, so the impact is latent. The parsers already disagree on valid input, though. Any revived or new caller would mark every agent from a pre-release build incompatible, and the protocol-version parser would read a pre-release protocol string as legacy.

## Recommendation

Add one `core::util::version` built on `semver::Version` (accepting a leading `v` and surrounding whitespace) with the major-equal and minor-at-least compatibility rule as a function. Replace `src-tauri::utils::version`, `parse_protocol_version` and `agent::update::version` with it. Delete `probe_remote_agent` and `is_version_compatible` if the probe stays unused.

## Verification

Confirmed. The desktop parse_semver requires exactly three split('.') integer parts, so it rejects 0.2.0-beta.1, while release.yml documents vX.Y.Z-beta.N prerelease tags. The agent and plugin parsers use semver. probe_remote_agent is registered, but api.ts probeRemoteAgent has no frontend callers, so the impact is latent, as the finding states.
