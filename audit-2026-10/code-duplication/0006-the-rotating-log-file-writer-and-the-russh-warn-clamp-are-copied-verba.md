---
id: DUP2-006
title: "The rotating log-file writer and the russh WARN clamp are copied verbatim between the agent and the desktop"
angle: code-duplication
severity: low
category: duplication
is_workaround: false
subsystem: "agent/src/file_log.rs + src-tauri/src/utils/file_log.rs"
evidence:
  - agent/src/file_log.rs:133-268
  - src-tauri/src/utils/file_log.rs:271-410
  - agent/src/file_log.rs:84
  - src-tauri/src/utils/file_log.rs:93
  - agent/src/main.rs:239
  - agent/src/file_log.rs:300-436
status: fixed
resolution: "#4319 — writer, log-family budget and russh clamp moved to core::diagnostics::file_log; agent and desktop keep only paths"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`RotatingLogFile`, `LockedRotator`, `Rotator` (open/path_in/rotate/Write) and their tests on size-cap rotation, generation shift, never splitting an event and bounded total usage are character-for-character identical in both crates. Apart from comment wording and the `with_defaults` directory lookup, `diff` shows no difference. The security-relevant `RUSSH_CLAMP = "russh=warn"` and the logic that prepends it to an override directive exist three times (agent file_log.rs:84, desktop file_log.rs:93, agent main.rs:239). The agent module says it 'mirrors src-tauri/src/utils/file_log.rs deliberately'. Crash-report writing, by contrast, was put in `core::diagnostics::crash_report` and is shared.

## Why it matters

The russh clamp keeps per-packet SSH cipher internals out of durable logs that users paste into issues. A change to it, or to the rotation bounds, must now be made in three places with nothing to catch drift. About 140 lines of logic and about 130 lines of tests are maintained twice.

## Recommendation

Move `RotatingLogFile` and its tests into `core::diagnostics::file_log`, parameterized by directory, stem, max bytes and max files, plus a `russh_clamped(directive) -> EnvFilter` helper. Keep only path resolution and the env-var name in each crate.

## Verification

Confirmed. A diff of the rotator sections shows only comment and with_defaults differences. RUSSH_CLAMP="russh=warn" is defined in agent/file_log.rs:84, src-tauri/utils/file_log.rs:93 and agent/main.rs:239. The agent module says it mirrors the desktop file 'deliberately', but no ADR forbids a core home, and crash_report is already in core.
