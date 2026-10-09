---
id: DUP2-009
title: "The agent's self-update asset-suffix map duplicates and has drifted from the desktop's; macOS agents never resolve a self-update asset"
angle: code-duplication
severity: low
category: duplication
is_workaround: false
subsystem: "agent/src/update/github.rs + src-tauri/src/terminal/agent_binary.rs"
evidence:
  - agent/src/update/github.rs:85-101
  - src-tauri/src/terminal/agent_binary.rs:44-76
  - .github/workflows/release.yml:709-713
  - .github/workflows/release.yml:791-793
  - .github/workflows/release.yml:857-859
status: fixed
resolution: "#4302 — desktop deployer and agent self-updater share core agent_asset_suffix; macOS resolves, Windows notify-only"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Two independent tables map platform to the published `termihub-agent-<suffix>` asset name. The desktop's `artifact_name_for_os_arch` covers linux x64/arm64/armv7, macos x64/arm64 and windows x64/arm64. The agent's `asset_suffix_for` returns `None` for every non-Linux OS, justified by the stale comment 'Agent binaries are published for Linux only', even though release.yml publishes `termihub-agent-macos-arm64`/`-x64` and the self-update apply path is `cfg(unix)`, which includes macOS.

## Why it matters

Because two copies of the contract drifted, an agent running on a macOS host with `--allow-self-update` never finds an asset and skips quietly. When a new architecture is added to the release matrix, two tables must be updated, and nothing flags a mismatch.

## Recommendation

Move one `agent_asset_suffix(os, arch) -> Option<&'static str>` into core (next to the agent-update signature and checksum helpers) that accepts both `std::env::consts` and `uname` spellings. Use it from the desktop deploy resolver and from `current_asset_suffix()`. Include or explicitly exclude macOS deliberately, and add a test that checks the table against the release.yml artifact list.

## Verification

Confirmed. agent/update/github.rs asset_suffix_for returns None for any non-linux OS, with the comment 'published for Linux only'. release.yml builds and uploads termihub-agent-macos-arm64/x64 (lines 791-793, 1112-1113), and apply.rs is cfg(unix). The desktop table covers macOS and Windows. Self-update on a macOS agent silently never resolves an asset.
