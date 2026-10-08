---
id: OBS2-001
title: "Release builds strip symbols, so field crash reports and panic logs carry backtraces nobody can symbolize"
angle: observability
severity: medium
category: diagnostics
is_workaround: false
subsystem: "Cargo.toml [profile.release]; src-tauri/src/utils/panic_hook.rs; agent/src/panic_hook.rs"
evidence:
  - Cargo.toml:88
  - Cargo.toml:93
  - src-tauri/src/utils/panic_hook.rs:93
  - src-tauri/src/utils/panic_hook.rs:97
  - agent/src/panic_hook.rs:56
  - core/src/diagnostics/crash_report.rs:95
status: open
resolution: ""
audit: 2026-10
commit: "663465d52"
relation: regression
previous_id: OBS-002
---

## What

OBS-002 was fixed by having a panic hook force-capture a std Backtrace into termihub.log and into a local crash report. The hook's comment (panic_hook.rs:93-96) says the capture 'still yields function symbols'. On 2026-09-19, after that fix, PKG-010 added `strip = true` to [profile.release] (Cargo.toml:93), and every shipped desktop and agent binary is a release build. A stripped binary has no symbol table, so std's Backtrace prints frames as `<unknown>` with absolute, ASLR-shifted addresses. The release workflows keep no separate debug-symbol artifact (no split-debuginfo, dSYM or PDB upload). The crash report records only the version, not the module load base or build id.

## Why it matters

A crash is the event a field post-mortem needs most. Right now every crash report a user exports from a shipped build has an empty backtrace. The Cargo.toml comment says symbols are 'recoverable from a debug build when profiling', but that is wrong for field crashes: you cannot symbolize a release build's ASLR addresses with a different debug build. The OBS-002 fix only works in dev builds.

## Recommendation

Pick one of these. (a) Use `strip = "debuginfo"` instead of `true`. This keeps the symbol table, so function names still resolve, and costs only a modest size increase. (b) Keep `strip = true`, but build with `split-debuginfo = "packed"`, attach the .dSYM/.pdb/.debug files as private release-workflow artifacts keyed by version and git hash, and add each loaded module's base address and the GIT_HASH to CrashDetails so reports can be symbolized offline. Either way, correct the comments in panic_hook.rs and Cargo.toml, and add a release-smoke check that a forced panic report contains a resolved termihub frame.

## Verification

Confirmed. Cargo.toml [profile.release] sets `strip = true`, with a comment saying symbols are 'recoverable from a debug build'. The panic_hook.rs comment that the capture 'still yields function symbols' only reasons about [profile.dev]. No workflow in .github/workflows uses split-debuginfo or uploads dSYM/PDB files, so a release backtrace cannot be symbolized.
