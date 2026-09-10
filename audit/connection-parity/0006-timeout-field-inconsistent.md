---
id: PARITY-006
title: Connect-timeout config field named / absent inconsistently across backends
angle: connection-parity
severity: medium
category: ux
is_workaround: false
subsystem: core/src/backends
evidence:
  - core/src/backends/ssh/mod.rs:423
  - core/src/backends/ftp/mod.rs:427
  - core/src/backends/docker/mod.rs:423
  - core/src/backends/telnet.rs:244
status: open
---

## What

Backends model the same concept — "how long to wait before giving up on a connect" — with
different field names, and most omit it entirely:

- **SSH:** `connectTimeoutSecs` (Number 1–300, default 45), documented as covering DNS + TCP +
  handshake.
- **FTP:** `timeoutSecs` (Number, default 30) — different key, different default, same concept.
- **Docker, telnet, local, serial, VNC, RDP, WSL:** **no connect-timeout field at all.**

Docker is the worst case: `connect()` performs a blocking image **pull** (`create_image` stream)
with no timeout, so an unreachable registry or a huge image can hang the connect indefinitely with
no user-configurable bound.

## Why it matters

- The connection editor is schema-driven (`DynamicForm`), so these inconsistencies surface directly
  to the user: an SSH connection has a "Connect Timeout (s)" field, an FTP one has "Timeout (s)",
  and a Docker one has neither. Same intent, three different presentations.
- A missing timeout is not just cosmetic — Docker/telnet connects can block far longer than SSH's
  bounded 45 s, and the user has no knob to shorten it.
- Field-name drift (`connectTimeoutSecs` vs `timeoutSecs`) means stored settings and any
  cross-backend tooling cannot treat the value uniformly.

## Evidence

- `core/src/backends/ssh/mod.rs:423` — `connectTimeoutSecs` field + `connect_timeout_secs` config.
- `core/src/backends/ftp/mod.rs:427` — `timeoutSecs` field.
- `core/src/backends/docker/mod.rs` — no timeout field; `connect()` pulls the image with no
  `tokio::time::timeout` wrapper (contrast FTP's `tokio::time::timeout(config.timeout(), …)`).
- `core/src/backends/telnet.rs:244` — schema has no timeout field.

## Recommendation

Standardise on one field key (e.g. `connectTimeoutSecs`) and add it to every backend that performs
a blocking connect, wrapping the connect/handshake (and Docker's image pull) in a
`tokio::time::timeout`. A shared helper for the "connection" settings group (host/port/timeout)
would prevent this drift, analogous to `shared_field_base()` for graphical backends.
