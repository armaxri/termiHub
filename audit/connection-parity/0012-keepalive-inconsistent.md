---
id: PARITY-012
title: Keepalive / liveness detection differs per backend without a shared policy
angle: connection-parity
severity: low
category: reliability
is_workaround: false
subsystem: core/src/backends
evidence:
  - core/src/backends/ssh/auth.rs:122
  - core/src/backends/telnet.rs:296
  - core/src/backends/ftp/mod.rs:135
status: open
---

## What

Each backend detects a dead link its own way, with no shared policy or configurability:

- **SSH:** SSH-level keepalive (`keepalive_interval: 30s`, `keepalive_max: 3`) plus TCP keepalive on
  the socket — but the interval/max are hard-coded, not user-configurable (contrast OpenSSH's
  `ServerAliveInterval`).
- **Telnet:** TCP keepalive on the socket only (no app-level probe).
- **FTP:** an application-level `NOOP` keep-alive loop, interval user-configurable via
  `keepAliveSecs` (default 60, 0 disables).
- **Docker / local / serial:** liveness is tied to process/stream EOF; no keepalive.

## Why it matters

- FTP exposes a keep-alive interval setting; SSH — the flagship backend — hard-codes 30 s and
  offers no knob, so a user on a link that needs shorter/longer probes can tune FTP but not SSH.
- The mechanisms are largely protocol-appropriate (this is why the finding is low, not a defect per
  se), but the *configurability* is inconsistent: one backend surfaces the control, the rest bury
  or omit it.

## Evidence

- `core/src/backends/ssh/auth.rs:122` — `keepalive_interval: Some(Duration::from_secs(30))`,
  `keepalive_max: 3`, hard-coded.
- `core/src/backends/telnet.rs:296` — `enable_tcp_keepalive(&stream)`.
- `core/src/backends/ftp/mod.rs:135` + `:442` — `keep_alive_loop` driven by the user-facing
  `keepAliveSecs` field.

## Recommendation

Expose the SSH keepalive interval as an advanced setting (matching FTP's `keepAliveSecs`), so the
two long-lived network backends offer the same tunable. A shared "keep-alive (s)" advanced field in
the common settings group would make this uniform. Where keepalive is protocol-inherent (serial,
local), leaving it out is correct.
