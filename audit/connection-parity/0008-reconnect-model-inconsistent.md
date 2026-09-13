---
id: PARITY-008
title: Reconnect / resilience modelled inconsistently, with opposite defaults
angle: connection-parity
severity: high
category: arch
is_workaround: false
subsystem: core/src/backends
evidence:
  - core/src/backends/ssh/mod.rs:493
  - core/src/connection/graphical.rs:148
  - core/src/backends/ftp/mod.rs:135
  - core/src/connection/graphical.rs:423
status: open
---

## What

"Automatically recover a dropped connection" is implemented three different ways, with different
names, different defaults, and different retry policies — and is absent for several backends:

- **SSH:** a `resilientReconnect` boolean setting (**default off**), plus an `onReconnectCommand`.
  Reconnect opens a *fresh* remote shell (server-side state is lost without an agent). Backoff is
  exponential.
- **Graphical (VNC/RDP/mock):** an `autoReconnect` boolean (**default on**) wired to a shared
  `SessionStateMachine` with a hard cap of `MAX_RECONNECT_ATTEMPTS = 3`.
- **FTP:** *silent* control-connection re-establishment — the keep-alive `NOOP` loop drops a dead
  idle connection and the next file op transparently reconnects (with an EPSV→PASV downgrade). No
  setting, no user visibility, no attempt cap.
- **telnet, local, serial, Docker:** no reconnect concept at all (the persistent ones rely on the
  separate agent-level session-reattach mechanism, which is a different layer again).

## Why it matters

- Opposite defaults are the sharpest issue: a VNC session silently retries by default, an SSH
  session does not. A user who learns the behaviour on one backend is wrong about the other.
- Three different names (`resilientReconnect`, `autoReconnect`, none) for the same user-facing idea
  make the connection editor inconsistent and settings non-portable across types.
- Different policies (SSH exponential/uncapped-ish vs graphical fixed max-3 vs FTP silent/uncapped)
  mean "auto-reconnect" means something different per backend, with no shared contract or shared
  state machine outside the graphical family.

## Evidence

- `core/src/backends/ssh/mod.rs:493` — `resilientReconnect` field, default `false`; `:519`
  `onReconnectCommand`.
- `core/src/connection/graphical.rs:148` — shared `autoReconnect` field, default `true`;
  `:423` `MAX_RECONNECT_ATTEMPTS = 3`; `SessionStateMachine` drives it.
- `core/src/backends/ftp/mod.rs:135` — `keep_alive_loop` drops dead connections for transparent
  reconnect; `reconnect.rs` handles the EPSV→PASV downgrade.

## Recommendation

Define one shared reconnect model and vocabulary (one setting name, one default policy, one attempt
cap concept) that terminal and graphical backends both consume — the graphical `SessionStateMachine`
is a good starting point and is already pure/testable. At minimum, reconcile the default (on vs off)
and the field name across SSH and the graphical backends so the editor presents one consistent
"Auto-reconnect" control.
