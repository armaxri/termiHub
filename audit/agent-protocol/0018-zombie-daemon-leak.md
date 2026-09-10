---
id: AGT-018
title: Session daemons that exit while their spawning worker lives become unreaped zombies (the #2580 daemon leak)
angle: agent-protocol
severity: medium
category: reliability
is_workaround: false
subsystem: agent/src/session/manager.rs, agent/src/daemon/spawn.rs
evidence:
  - agent/src/session/manager.rs:268
  - agent/src/daemon/spawn.rs:64
status: open
---

## What
`SessionManager` spawns the detached daemon and, on success, **drops the
`std::process::Child` without ever `wait()`-ing it** (`agent/src/session/manager.rs:268-284`).
`setsid` (`agent/src/daemon/spawn.rs:64`) does not reparent — the daemon's parent stays the
worker until the worker itself exits. So any daemon that terminates while its spawning worker
is still alive (shell exits, `MSG_KILL`, crash) becomes a **zombie held in the worker's
process table** with no reaper. A long-lived worker cycling through many persistent sessions
accumulates zombies (PID-table / fd pressure). This is the concrete substance behind the
MEMORY note "#2580 test daemon leak." The failure path calls `child.kill()` (`:287`) but
still never reaps.

## Why it matters
Zombie accumulation on a long-running agent is a slow resource leak that degrades a host over
time — precisely the kind of drift a ventilator-grade deployment (long uptime) cannot afford.

## Evidence
- `agent/src/session/manager.rs:268-287` — `Child` dropped/killed, never `wait()`ed.
- `agent/src/daemon/spawn.rs:64-70` — `setsid` without double-fork, so no reparent-to-init.

## Recommendation
Double-fork the daemon so it reparents to init immediately (no zombie), or install a
`SIGCHLD`/`waitpid` reaper in the worker. Verify with a leak test (the #2580 tracker).
