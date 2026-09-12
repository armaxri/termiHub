---
id: DUP-007
title: Exponential backoff is reimplemented in several reconnect/retry loops despite core::reconnect_backoff
angle: code-duplication
severity: medium
category: reliability
is_workaround: false
subsystem: src-tauri (terminal/agent_manager, tunnel/tunnel_manager, files/transfer)
evidence:
  - core/src/reconnect_backoff.rs:52
  - src-tauri/src/terminal/agent_manager.rs:2626
  - src-tauri/src/tunnel/tunnel_manager.rs:1767
  - src-tauri/src/files/transfer/retry.rs:28
status: open
---

## What

`core::reconnect_backoff` exists as the intended shared exponential-backoff-with-jitter primitive
(`BackoffConfig`, `ReconnectState`, `DEFAULT_BACKOFF`) and is used by core FTP reconnect, core SSH
monitoring, the desktop `session_projection`, and the agent monitor. But at least three other
reconnect/retry loops hand-roll their own exponential backoff instead of using it:

- Agent reconnect: `src-tauri/src/terminal/agent_manager.rs:2626` — `min(2^attempt, MAX_BACKOFF_SECS)`.
- Tunnel reconnect: `src-tauri/src/tunnel/tunnel_manager.rs:1767` — `backoff_delay(attempt, base, cap)`.
- Transfer retry: `src-tauri/src/files/transfer/retry.rs:28` — `backoff_delay(failed_attempts)`.

A separate cap constant lives in `core/src/monitoring/status.rs` (`BACKOFF_CAP = 30s`,
`DEFAULT_BACKOFF_BASE = 1s`) that mirrors the same 30s ceiling used elsewhere.

## Why it matters

Backoff is reconnect-critical behavior. Having four independent implementations means a policy fix
(jitter to avoid thundering-herd, respect a max-attempts cap, cancellation semantics) applied to
one loop does not reach the others, and their ceilings/curves already differ. This is a "core has
the primitive but callers don't use it" gap — the centralization is present but not pulling its
weight.

## Evidence

- `core/src/reconnect_backoff.rs:52` — `pub const DEFAULT_BACKOFF: BackoffConfig`.
- `src-tauri/src/terminal/agent_manager.rs:2623-2629` — `MAX_BACKOFF_SECS = 30`, `2u64.pow(attempt)`.
- `src-tauri/src/tunnel/tunnel_manager.rs:1767-1787` — local `fn backoff_delay(attempt, base, cap)`.
- `src-tauri/src/files/transfer/retry.rs:28` — local `pub fn backoff_delay(failed_attempts)`.

## Recommendation

Route the agent-reconnect, tunnel-reconnect, and transfer-retry loops through
`core::reconnect_backoff` (extend it with a max-attempts/`None`-terminates variant if the transfer
path needs "give up"). Fold the `monitoring::status` backoff constants into the same module so
there is one backoff curve + one ceiling for the whole app.
