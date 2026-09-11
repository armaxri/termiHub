---
id: ERR-007
title: SSH env-var, X11-forward, and related failures are silently discarded with `let _ =`
angle: error-handling
severity: medium
category: reliability
is_workaround: false
subsystem: core/src/backends/ssh
evidence:
  - core/src/backends/ssh/connector.rs:256
  - core/src/backends/ssh/x11.rs:348
  - core/src/backends/ssh/x11.rs:357
status: fixed
resolution: "#2763"
---

## What
Several SSH-side operations discard their `Result` with `let _ =`, so a failure produces no error, no toast, and no log:

- **Env vars:** `core/src/backends/ssh/connector.rs:256` — `let _ = channel.set_env(false, key, value).await;`. If the SSH server rejects `SetEnv` (the default on most `sshd` unless `AcceptEnv` is configured — the common case), **every environment variable the user configured for that connection is silently dropped.** The session opens looking healthy; the user's `LANG`, `TERM`, proxy vars, etc. simply aren't there, and there is no way to tell from the UI or the log.
- **X11 forwarding:** `core/src/backends/ssh/x11.rs:348,357` — `let _ = tokio::io::copy_bidirectional(...).await;` on the forwarded channel. A forwarding failure or mid-stream error is swallowed; X11 apps fail to display with no diagnostic.

## Why it matters
- **A configured feature silently doesn't work.** Env-var passing is a checkbox/field the user filled in; when `set_env` is rejected the feature is a no-op with zero feedback — the classic "lying success" shape, but at the protocol level. The user debugs the wrong thing (their shell, their remote profile) because the app never says "the server refused SetEnv."
- These are on the SSH backend, the most-used remote path; the failures are *expected* (server policy), not exotic, which makes the silence worse.
- Prior `backend-core-rust` findings (CORE-004 exec exit-signal, CORE-007 SSH shell-write, CORE-018 serial-write) document the same "silent swallow on the SSH/serial write path" family; this adds the **env/X11 configuration-silently-ignored** members that turn a *configured* option into a no-op.

## Evidence
- `core/src/backends/ssh/connector.rs:256` — env var set result discarded.
- `core/src/backends/ssh/x11.rs:348,357` — X11 forward copy result discarded.

## Recommendation
- For `set_env`: collect per-var results; if any are rejected, surface a **non-fatal warning** ("server rejected N environment variables; enable `AcceptEnv` on the host") into the session's log/diagnostics rather than dropping it. The session can still proceed, but the user must be told.
- For X11 `copy_bidirectional`: log the error (target `ssh::x11`) so a failed forward is diagnosable; keep it non-fatal.
- Distinguish these *actionable* discards from genuine best-effort teardown `let _ =` (the majority per WA-RS-008), which are fine.
</content>
