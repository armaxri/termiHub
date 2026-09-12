---
id: OBS-003
title: Agent has no durable log; agent logs don't reach support for daemon/listen roles
angle: observability
severity: medium
category: reliability
is_workaround: false
subsystem: agent/src/main.rs, src-tauri/src/terminal/agent_manager.rs
evidence:
  - agent/src/main.rs:205
  - src-tauri/src/terminal/agent_manager.rs:2196
status: fixed
resolution: "#2855 — agent now writes durable rotating log (5MiB×3) at <config-dir>/logs/termihub-agent.log for ALL roles incl daemon/listen (mirrors desktop file_log; russh clamped; best-effort no-panic). Structured-over-stdio framing → #2854"
---

## What
The remote agent logs only to **stderr** with a fixed `info` default and no file, no
rotation, no ring buffer (`agent/src/main.rs:205`):
```rust
fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_writer(std::io::stderr)
        .init();
}
```
Where that stderr ends up depends on the run mode:
- `--stdio` (interactive, launched over an SSH exec channel): the desktop captures stderr
  as SSH `ExtendedData ext:1` and re-logs it into the desktop pipeline at **WARN**,
  line-by-line (`agent_manager.rs:2196`, `"Agent {}: stderr: {}"`). So interactive-agent
  logs *do* reach `termihub.log` — but everything the agent logged at its own INFO/DEBUG is
  flattened to a desktop-side WARN string, losing the agent's real level/target/timestamp.
- `--daemon` / `--listen` (the persistent daemon and registry-daemon roles): stderr goes to
  the **remote host** with no capture path back to the desktop. Those logs are unreachable
  by the user or a supporter unless they SSH in and find them — and nothing writes them to
  a file there either.

## Why it matters
The agent is where session persistence, reconnect, cross-desktop registry, and remote
tunnels/services actually run. When a session is evicted or a reconnect fails on the agent
side (see OBS-012), the durable record that would explain it lives only in a stderr stream
that is either flattened to a WARN string or lost on the remote host. A supporter working
from the user's `termihub.log` gets, at best, a lossy shadow of the agent's own view.

## Evidence
`agent/src/main.rs:205-211` — stderr-only subscriber, `info` default, no file sink.
`src-tauri/src/terminal/agent_manager.rs:2196` — desktop captures interactive-agent stderr
as a WARN line; there is no equivalent capture for daemon/listen roles.

## Recommendation
Give the agent the same durable file sink the desktop already has (reuse the
`file_log`-style rotating writer, in the remote user's data/log dir), so daemon/listen roles
leave a bounded on-disk trace a supporter can retrieve. For the interactive channel, prefer
a structured framing of agent log records over the stdio side-band (or a dedicated log RPC)
so the desktop can re-emit them at their real level/target instead of collapsing to WARN —
this is also the natural place to attach the correlation id from OBS-004.
