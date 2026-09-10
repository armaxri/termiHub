---
id: OBS-006
title: SSH env-var apply failures are silently discarded with no log line
angle: observability
severity: medium
category: bug
is_workaround: false
subsystem: core/src/backends/ssh/connector.rs
evidence:
  - core/src/backends/ssh/connector.rs:256
status: open
---

## What
When applying user-specified SSH environment variables via the channel `env` request, the
result is dropped with `let _ =` and nothing is logged at any level:
```rust
for (key, value) in &config.env {
    let _ = channel.set_env(false, key, value).await;   // connector.rs:256
}
```
If the server rejects a name (not in its `AcceptEnv`) or the request otherwise fails, there
is **no diagnostic** — no DEBUG, no WARN. The surrounding comment notes rejected names are
"covered by the `export` injection after the shell starts," so there is often a functional
fallback, but the failure itself is invisible: a user whose environment variable didn't take
effect has no log line explaining why.

## Why it matters
"My `TERM`/`LANG`/custom var isn't set on the remote" is a common, confusing support
question. Today the log offers zero signal that the `env` request was attempted, which names
were passed, or which were rejected — the supporter cannot distinguish "we never tried"
from "the server refused" from "the fallback export ran." This is one of the SSH
env/X11/WSL error-discard paths other experts flagged; X11 forwarding by contrast logs its
failures well (`ssh/x11.rs` and `connector.rs:217`), so the fix is to bring env parity.

## Evidence
`core/src/backends/ssh/connector.rs:256` — `let _ = channel.set_env(false, key, value).await;`
No `tracing` call in the loop. Contrast `connector.rs:217`:
`tracing::warn!("X11 forwarding setup failed, continuing without it: {e}")`.

## Recommendation
Log the per-name outcome at DEBUG on success and WARN on error, e.g.
`debug!(key, "sent SSH env request")` / `warn!(key, error = %e, "SSH env request rejected;
relying on export fallback")`. Never log `value` (it may carry secrets — see OBS-Security
overlap; keep parity with the credential-command hygiene). Consider surfacing a single
aggregated INFO ("N of M env vars accepted by server") so the durable file at INFO level
records that env application happened at all.
