---
id: WA-CI-001
title: 16 live-agent-TCP tests quarantined on Windows via #[cfg_attr(windows, ignore)]
angle: workaround-ci-scripts
severity: high
category: test-gap
is_workaround: true
subsystem: agent/tests
evidence:
  - agent/tests/local_agent_integration.rs:1083
  - agent/tests/local_agent_integration.rs:1095
  - agent/tests/tcp_listener_readiness.rs
  - .github/workflows/agent.yml:96
status: open
---

## What
The 16 live-agent-TCP integration tests (15 in `agent/tests/local_agent_integration.rs`,
1 in `agent/tests/tcp_listener_readiness.rs`) are compiled out on the Windows CI leg with
`#[cfg_attr(windows, ignore = "flaky under Windows-runner oversubscription; see #2495")]`.
The shared `build-windows` job (`cargo test -p termihub-agent -p termihub-core --all-features`,
`agent.yml:96`) therefore skips all of them, so the Windows agent transport path has **zero
gating integration coverage** in per-PR CI.

## Why it matters
Windows is a shipping platform. The agent's live TCP connect/read path is the exact surface
that has repeatedly regressed on Windows (`Os { code: 10060, TimedOut }`). Quarantining the
whole subset on Windows means a real Windows-only agent transport regression can merge
undetected. This is a genuine coverage hole on a release platform, not a cosmetic skip.

## Evidence
15 `ignore = "flaky under Windows-runner oversubscription; see #2495"` attributes in
`local_agent_integration.rs` (grep: lines 1083, 1095, 1121, 1147, 1541, 1572, 1609, 1663,
1761, 2168, 2235, 2336, 2483, 2578, 2676, …) plus the one in `tcp_listener_readiness.rs`.

## Recommendation
Tracked by **#2495** (open deep-fix). The two grade lanes (WA-CI-002, WA-CI-003) exist to
prove a serial+isolated run is deterministically green. The real fix is to land the
root-cause fix for Windows cold-start oversubscription (the aggregate concurrency gate
#2528/#2501 was a band-aid), confirm many consecutive green grade runs, then delete the
`#[cfg_attr(windows, ignore …)]` attributes so the tests run per-PR on Windows again and
close #2495. Do not un-quarantine on 3 green runs (chronic-flake bar).
