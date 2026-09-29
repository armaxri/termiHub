---
id: OBS-002
title: No panic/crash reporting; panics leave no durable trace and backtraces lose line info
angle: observability
severity: high
category: reliability
is_workaround: false
subsystem: src-tauri, core, agent, Cargo.toml
evidence:
  - Cargo.toml:36
  - src-tauri/src/lib.rs:329
status: fixed
resolution: "#2734 — panic hook (src-tauri); agent init_tracing left as follow-up"
---

## What
There is no crash/panic reporting anywhere in the stack:

- **No `panic::set_hook`** is installed in `src-tauri`, `core`, or `agent` for logging.
  (The only `set_hook` calls are a test in `connection/config.rs` and `catch_unwind`
  guards around plugin FFI in `core/src/plugin/host.rs` — neither logs a crash.) A panic
  in the desktop process prints to stderr, which for a bundled desktop app goes nowhere,
  and unwinds; **nothing is written to `termihub.log`**. The durable-log module exists
  precisely so the app "leaves evidence of what it was doing" — but the one event that
  most needs capturing, the crash, is not captured.
- **`[profile.dev] debug = 0`** (`Cargo.toml:36`) deliberately strips file/line from panic
  backtraces (documented trade-off for disk). So even a backtrace that *is* seen (dev
  runs, `RUST_BACKTRACE=1`) names only function symbols, no source location.
- **Agent panics** go to the agent process's stderr on the remote host. Only the
  interactive stdio channel's stderr is relayed to the desktop log (as WARN, line-by-line,
  `agent_manager.rs:2196`); a panicking `--daemon`/`--listen` agent leaves its trace solely
  on the remote machine.

## Why it matters
For a safety-critical tool that must be diagnosable in the field, a crash is the highest-value
event to record and the one this stack records least. A user reporting "it crashed" can
supply a `termihub.log` that ends abruptly with no panic message, no location, no backtrace —
the supporter cannot tell a crash from a clean exit, let alone where it happened.

## Evidence
`Cargo.toml:36` — the trade-off comment: *"this strips file/line from panic backtraces… a
backtrace still names the function symbols but reports no source location."*
`src-tauri/src/lib.rs:329` — the subscriber is initialized, but no panic hook is registered
alongside it. Grep for `panic::set_hook` across production code returns only the test in
`connection/config.rs`.

## Recommendation
Install a `std::panic::set_hook` early in `lib.rs::run()` (and in the agent's
`init_tracing`) that emits the panic payload + location + a captured `Backtrace` through
`tracing::error!` so it lands in the ring buffer **and** the durable file before the
process dies (the file sink is synchronous, so the write survives). Consider `panic =
"abort"` only in release after the hook has logged. Ship `-C debuginfo=1` (file/line only,
cheap) for **release** builds so field backtraces carry source locations even though dev
keeps `debug=0`. Optionally evaluate a minimal offline crash-dump (see OBS-010).
