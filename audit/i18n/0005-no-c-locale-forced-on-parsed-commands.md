---
id: I18N-005
title: No parsed remote/local command forces LC_ALL=C — safe only by data source
angle: i18n
severity: medium
category: reliability
is_workaround: false
subsystem: core/monitoring, core/backends/ssh, agent/monitoring, core/network
evidence:
  - core/src/monitoring/parser.rs:13
  - core/src/backends/ssh/monitoring.rs:114
  - agent/src/monitoring/collector.rs:214
  - core/src/backends/ssh/exec.rs
status: in-progress
resolution: "#2731"
---

## What
A repo-wide search found **zero** sites that force `LC_ALL=C` / `LANG=C` /
`LANGUAGE=C` (or `env -i`) before running a command whose output the app then
parses. The monitoring command
`hostname && cat /proc/loadavg && head -1 /proc/stat && cat /proc/meminfo &&
cat /proc/uptime && df -Pk / && uname -sr` (parser.rs:13, run at
ssh/monitoring.rs:114 and agent/monitoring/collector.rs:214) parses load
averages, memory, uptime and `df` output with no locale pinning.

These paths happen to be **safe today only by data source**, not by design:

- `/proc/loadavg`, `/proc/uptime`, `/proc/stat`, `/proc/meminfo` are emitted by
  the kernel with `.` decimals and no digit grouping regardless of locale.
- `df -Pk` uses POSIX 1024-block integer output (the `-P` flag) with an integer
  percent — no grouping, no localized decimals.

## Why it matters
Bucket-adjacent: not a live crash, but a **latent, un-guarded fragility on a
monitored hot path**. The correctness rests entirely on continuing to read
`/proc` and continuing to pass `df -P`. The moment anyone:

- switches to `df` without `-P`, or to `free`, `vmstat`, `top`, `uptime`'s
  pretty form, or any tool that honours `LC_NUMERIC` (thousands separators,
  comma decimals), or
- runs against a system that localizes these,

the numeric parsers (`parse::<f64>` / `parse::<u64>`) silently produce wrong
values or `unwrap_or(0)` defaults, with no defence and no test to catch it. For
a monitoring feature in a safety-critical app, "correct by accident of which
file we read" is a reliability gap worth closing proactively.

## Evidence
- `core/src/monitoring/parser.rs:13` — the command string, no locale prefix.
- `core/src/backends/ssh/monitoring.rs:114` / `agent/src/monitoring/collector.rs:214`
  — both exec it with no environment set.
- `core/src/backends/ssh/exec.rs` — the shared SSH exec helper sets no env on the
  channel before `exec`.
- Contrast (safe by design, no parsing of localized text): `core/network/ping.rs`
  and `traceroute.rs` measure latency via Rust `Instant` over raw sockets;
  `agent/monitoring/collector.rs:72` uses the `sysinfo` crate; SSH file browsing
  uses SFTP protocol metadata (numeric epoch mtimes).

## Recommendation
Adopt a standing rule: **every command whose stdout/stderr is parsed is prefixed
with `LC_ALL=C LANG=C`.** Centralize this in the exec helpers (SSH exec, docker
exec, agent exec) so individual call sites can't forget it. This is defence in
depth for the monitoring path and the actual fix for I18N-003/004 and the FTP
month-name issue (I18N-006). Add a lint/test asserting parsed-command builders
carry the C-locale prefix.
