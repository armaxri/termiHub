---
id: AGT-019
title: Stale session socket and log files are never reclaimed after a daemon crash — unbounded inode leak
angle: agent-protocol
severity: medium
category: reliability
is_workaround: false
subsystem: agent/src/daemon/transport.rs, agent/src/session/manager.rs
evidence:
  - agent/src/daemon/process.rs:116
  - agent/src/session/manager.rs:875
  - agent/src/daemon/transport.rs:258
status: open
---

## What
A daemon killed with SIGKILL or crashing never runs `listener.cleanup()`
(`agent/src/daemon/process.rs:116`), leaving `session-<id>.sock` and `session-<id>.log`
(`agent/src/daemon/transport.rs:258`) behind in `/tmp/termihub/<user>`. Recovery does not
delete them: `recover_sessions` (`agent/src/session/manager.rs:875`) treats
`endpoint_alive` (a mere `Path::exists`) as "alive", fails `connect_for_recovery`, and
removes only the **state.json entry** — the on-disk `.sock`/`.log` persist forever. A worker
reclaims its *own* path on rebind, but nothing sweeps *other* dead sessions' files. Across
many crashes these accumulate without bound (inode/disk leak). On Linux tmpfs a reboot clears
them; macOS does not reliably.

## Why it matters
Another slow leak on a long-uptime host, and it compounds AGT-017 (a lost state entry leaves
the files with no referent). Disk/inode exhaustion in `/tmp` eventually breaks new session
creation for everyone on the host.

## Evidence
- `agent/src/daemon/process.rs:116` — cleanup only on graceful daemon exit.
- `agent/src/session/manager.rs:875-881` — recovery removes the state entry, not the files.
- `agent/src/daemon/transport.rs:258-275` — socket + truncating log per session.

## Recommendation
Add a sweeper that, during recovery/startup, deletes `.sock`/`.log` files whose session is
dead (connect fails) and whose state entry is gone. Consider moving the sockets to
`$XDG_RUNTIME_DIR` (auto-cleaned on logout) — see AGT-020.
