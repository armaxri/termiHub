---
id: CONC2-002
title: "Desktop SessionManager holds the app-wide sessions mutex across blocking session writes and resizes"
angle: concurrency-reliability
severity: medium
category: bug
is_workaround: false
subsystem: src-tauri/session/manager
audit: 2026-10
commit: 663465d52
relation: new
status: fixed
resolution: "#4300 — session writes/resizes run outside the session-map lock; per-session order kept, close defers disconnect"
evidence:
  - src-tauri/src/session/manager.rs:1420
  - src-tauri/src/session/manager.rs:1425
  - src-tauri/src/session/manager.rs:1442
  - src-tauri/src/session/manager.rs:1483
  - core/src/backends/local_shell.rs:716
  - src-tauri/src/terminal/agent_manager.rs:2498
  - src-tauri/src/terminal/agent_manager/io_lanes.rs:319
  - src-tauri/src/terminal/agent_manager/io_lanes.rs:345
  - src-tauri/src/terminal/agent_manager/io_lanes.rs:356
---

## What

`write_session` takes `sessions.lock().await` (the tokio Mutex over every session in the app), borrows `entry` from the guard, and runs `tokio::task::block_in_place(|| entry.connection.write(&data))` with the guard still held. Resize does the same at :1483. These writes can block with no bound. A local PTY write is a blocking `write_all` + `flush` (local_shell.rs:716) that stalls once the child stops reading stdin and the PTY input queue fills. An agent-session write waits in `IoBudget::acquire_blocking` on a Condvar with no timeout (io_lanes.rs:319-356) until the I/O task frees credit, which never happens while the remote side is not consuming input but the transport stays up (so `reconnecting` is not set).

## Why it matters

A large paste into a program that is not reading input (a busy full-screen app, a hung command, or a remote session whose 1 MiB credit budget is exhausted) parks that write while it holds the global sessions map. Until that one program reads its input, every other tab, local or remote, freezes: input, resize, close, list_sessions and create all wait. block_in_place keeps the runtime alive, but the lock still serializes the whole app behind one stalled consumer. Single-session backpressure becomes a freeze across all tabs.

## Recommendation

Do not hold the map lock across the write. Store each session's connection behind an `Arc` (or an `Arc<dyn ConnectionType>` / a per-session writer handle), clone it out under a brief lock, release the lock, then do the blocking write and resize. A per-session async mutex keeps input order within one session. Optionally bound the agent credit wait (or make it interruptible on close) so a closed tab releases a parked writer. Add a test: a fake connection whose `write` blocks must not stop `write_session` for a second session from completing.

## Verification

I confirmed this from the code at develop 663465d52. `write_session` (manager.rs:1420-1443) takes `sessions.lock().await`, borrows `entry` from the guard, and calls `block_in_place(|| entry.connection.write(&data))` while still holding the lock. `resize` (manager.rs:1475-1485) does the same. That lock is the tokio Mutex over the whole sessions map, and the session entry holds its connection as a `Box<dyn ConnectionType>` (manager.rs:355). Because the connection is a Box borrowed from inside the map, there is no Arc that could be cloned out first.

The two blocking paths are real:

- **Local shell:** `write` is a synchronous `write_all` plus `flush` on the PTY writer (local_shell.rs:708-718). It blocks once the PTY input queue is full and the child is not reading. The early `is_connected()` check only skips sessions that are already dead.
- **Agent sessions:** `write_session_input` (agent_manager.rs:~2490) sends large pastes in chunks through `send_blocking`. That leads to `IoBudget::acquire_blocking` (io_lanes.rs:319-356), which waits on a Condvar with no timeout. The wait only ends when credit is released, the transport is marked reconnecting, or the channel closes.

I found no guard elsewhere, and neither the architecture doc nor FINAL-SUMMARY records a decision to accept this. A parked write therefore stops every other tab's input, resize, close and list until that one program reads its input. That includes Ctrl-C to the stuck tab and closing it, since both need the same lock. The user can only recover by killing the child from outside the app.

I lowered the severity from high to medium because it only happens in an edge case. Someone has to paste more than the PTY buffer holds (about 4 KB) into a program that is not reading input, or more than 1 MiB of agent credit into a remote that is up but not consuming input. Normal typing and normal pastes into a shell that is reading input are not affected, and no data is lost or corrupted. The freeze ends as soon as the program reads its input.
