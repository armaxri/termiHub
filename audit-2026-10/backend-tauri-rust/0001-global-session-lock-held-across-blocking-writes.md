---
id: TAURI2-001
title: "One stalled tab freezes input, resize, close and create in every tab: write_session/resize hold the global session-map lock during blocking backend writes"
angle: backend-tauri-rust
severity: high
category: bug
is_workaround: false
subsystem: session/manager (SessionManager input/resize path)
evidence:
  - src-tauri/src/session/manager.rs:1425
  - src-tauri/src/session/manager.rs:1444
  - src-tauri/src/session/manager.rs:1479
  - src-tauri/src/session/manager.rs:1483
  - src-tauri/src/session/manager.rs:1607
  - src-tauri/src/session/manager.rs:1765
  - core/src/backends/local_shell.rs:716
  - core/src/backends/telnet/mod.rs:405
  - src-tauri/src/terminal/agent_manager.rs:2498
  - src-tauri/src/terminal/agent_manager/io_lanes.rs:359
status: fixed
resolution: "#4300 — session writes/resizes run outside the session-map lock; per-session order kept, close defers disconnect"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`write_session` takes the one map-wide `tokio::sync::Mutex` that holds every session
(`self.sessions`). It then runs the backend's synchronous write inside `block_in_place`
while still holding that guard (manager.rs:1425-1444). `resize` does the same
(1479-1484). Several backends can block in that write for a long or unbounded time:

- LocalShell/WSL do a blocking `write_all` on the PTY master (local_shell.rs:716). It
  blocks as soon as the foreground process stops reading stdin and the tty input queue
  (about 4 KB) is full.
- Telnet does a blocking `TcpStream::write_all` with no write timeout
  (telnet/mod.rs:405). On a half-open connection it waits until TCP gives up.
- Agent sessions use `send_blocking`, which waits without limit for queue credit
  (io_lanes.rs:359, agent_manager.rs:2498) until the I/O task frees credit or the
  transport is marked reconnecting.

The comment at manager.rs:1440 says block_in_place "lets tokio keep processing other
tasks". That is true for the runtime, but the map lock stays held the whole time. #4092
(commit d1e305a2f) fixed exactly this pattern in `close_session` and left the input and
resize paths unchanged.

## Why it matters

A realistic trigger: paste a multi-KB block into a local shell while a command that does
not read stdin is running (`sleep 60`, a build, a hung program). Or type into a telnet tab
whose peer has silently gone away. While that one write is stuck:

- Typing into every other tab stalls, because `send_input` goes through `write_session`.
- Ctrl+C sent to the stuck tab queues behind the same lock, so the user cannot interrupt
  the program that would drain the input.
- Closing the stuck tab cannot proceed, because `close_session` needs the same lock at
  manager.rs:1607.
- Resizes, `list_sessions` (1765), new session creation and exit cleanup of other
  sessions all block too.

The app looks hung across all tabs until the blocked process reads its input, which may
never happen. This is the head-of-line blocking #4092 already judged release-relevant,
still present on the most frequent IPC path.

## Evidence

- `session/manager.rs:1425-1444` — `write_session` holds `sessions.lock().await` across
  `block_in_place(|| entry.connection.write(&data))`.
- `session/manager.rs:1479-1483` — `resize` holds the same guard across
  `connection.resize`.
- `session/manager.rs:1607` — `close_session` needs the same lock to remove the entry.
- `session/manager.rs:1765` — `list_sessions` takes the same lock.
- `core/src/backends/local_shell.rs:716` — blocking PTY master `write_all`.
- `core/src/backends/telnet/mod.rs:405` — blocking `TcpStream::write_all`, no write timeout.
- `terminal/agent_manager.rs:2498`, `terminal/agent_manager/io_lanes.rs:359` — unbounded
  `send_blocking` credit wait.

## Recommendation

Do not hold the map lock across backend I/O, just as #4092 does for close. Store each
session's connection as `Arc<dyn ConnectionType>`, or keep a per-entry `Arc`
writer/resizer handle. Look the session up and clone the `Arc` under the lock, drop the
guard, then run `block_in_place(|| conn.write(..))` or `resize`. To keep per-session input
ordering without the global lock, use a per-session writer mutex or a per-session writer
task with a bounded queue. Add a regression test in session/manager/tests.rs: a mock
`ConnectionType` whose `write` blocks on a barrier must not stop `send_input` on a second
session, `resize`, or `close_session` of the blocked one. As defence in depth, give
telnet's `TcpStream` a write timeout.

## Verification

Confirmed against develop @ 663465d52; no evidence reference could be refuted.

- `SessionManager.sessions` is one map-wide `Arc<tokio::sync::Mutex<Sessions<SessionEntry>>>`
  (manager.rs:545, 722). `write_session` (1420-1445) and `resize` (1475-1485) keep the
  guard alive across the blocking backend call. The `is_connected()` fast-path only helps
  sessions already marked dead. `send_input` / `resize_terminal` (commands/session.rs:323, 367) go straight through these paths; there is no per-session writer outside the manager.
- LocalShell (local_shell.rs:708-718) blocks once the slave input queue is full (macOS
  TTYHOG about 1 KB, Linux n_tty about 4 KB). Telnet has no `set_write_timeout` or
  nonblocking call. Agent `send_blocking` waits on the credit condvar with no timeout.
- #4092 moved `disconnect()` out from under this lock in `close_session`, with a comment
  that holding it "froze every other session operation (create, list, input routing)" —
  the same hazard, still present on input and resize. No ADR or deliberate decision in
  docs/architecture.md or audit/FINAL-SUMMARY.md covers it.
- Severity kept at high. Caveat: Ctrl+C to the stuck tab would still wait behind that
  backend's own per-session writer mutex even with a per-session map lock, so part of the
  "cannot interrupt" claim is per-session. The cross-tab stall is real, realistically
  triggered, possibly indefinite, and the fix pattern already exists in #4092.
