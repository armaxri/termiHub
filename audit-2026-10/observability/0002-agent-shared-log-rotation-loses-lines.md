---
id: OBS2-002
title: "Agent processes share one rotating log file, so rotation in one process sends other processes' log lines to renamed or deleted archives"
angle: observability
severity: medium
category: reliability
is_workaround: false
subsystem: "agent/src/file_log.rs"
evidence:
  - agent/src/main.rs:279
  - agent/src/main.rs:297
  - agent/src/file_log.rs:192
  - agent/src/file_log.rs:196
  - agent/src/file_log.rs:221
  - agent/src/file_log.rs:236
  - agent/src/file_log.rs:240
  - agent/src/file_log.rs:254
  - agent/src/session/manager.rs:518
  - agent/src/registry_daemon/client.rs:340
status: open
resolution: ""
audit: 2026-10
commit: "663465d52"
relation: new
---

## What

Every agent role calls init_tracing, which opens a RotatingLogFile on the same <config-dir>/logs/termihub-agent.log. The roles are --stdio, --listen, one --daemon process per persistent session (manager.rs:518) and --registry-daemon (client.rs:340), and on one host they run as several separate processes at once. Each process keeps its own file handle and its own `written` counter (file_log.rs:196), and rotation is plain rename/remove by path (file_log.rs:236-244). When process A rotates, the open handles of processes B, C and so on now point at termihub-agent.1.log. After a second rotation they point at .2.log, and after a third their file is unlinked (remove_file at :236). Their later writes go into an unlinked inode until each process rotates on its own counter. A quiet, long-lived per-session daemon may never write enough to rotate.

## Why it matters

OBS-003 was fixed so the --daemon and --registry-daemon roles leave a retrievable trace. In practice the long-lived low-volume daemons, which are the processes behind session persistence and reconnect, lose their lines as soon as a busier sibling process rotates the file twice. The module header also promises a hard on-disk ceiling of 5 MiB × 3 'always', which no longer holds: unlinked-but-open files and per-process counters let total usage go past it.

## Recommendation

Make rotation safe across processes. One way: before each write (or every N writes), compare the live path's inode/file id with the open handle and reopen if they differ, and take the size from fstat on the path rather than a per-process counter. Another: take an advisory lock (flock/LockFileEx) on a sibling .lock file around the rotate-and-reopen step. Simplest: give each role its own stem (for example termihub-agent-daemon-<session>.log with a small per-file cap, or one file per role), and add a test where two RotatingLogFile instances on the same dir write and rotate alternately and check that no line is lost.

## Verification

Confirmed. init_tracing is called for every role: --stdio, --listen, --daemon and --registry-daemon (main.rs:165/174/193/202). Each process opens its own Rotator, which keeps a per-process `written` counter and rotates by path with rename/remove_file and no lock or inode recheck. Concurrent processes therefore keep writing to renamed or unlinked files. The 'always' ceiling claimed in the module header does not hold. The stderr session log partly mitigates the loss, but it is deleted when the session dies.
