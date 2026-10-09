---
id: CONC2-001
title: "connect_agent holds the global agents std::Mutex across the whole SSH connect, keyboard-interactive prompt and initialize handshake"
angle: concurrency-reliability
severity: high
category: bug
is_workaround: false
subsystem: src-tauri/terminal/agent_manager
audit: 2026-10
commit: 663465d52
relation: new
status: fixed
resolution: "#4304 — connect reserves the agent and releases the agents lock; SSH connect, prompts and initialize run off-lock, lock re-taken only to publish (cancel-checked); fake-sshd tests prove agent B stays responsive"
evidence:
  - src-tauri/src/terminal/agent_manager.rs:1005
  - src-tauri/src/terminal/agent_manager.rs:1065
  - src-tauri/src/terminal/agent_manager.rs:1069
  - src-tauri/src/terminal/agent_manager.rs:1138
  - src-tauri/src/terminal/agent_manager.rs:1340
  - src-tauri/src/terminal/agent_manager.rs:1350
  - core/src/backends/ssh/auth.rs:66
  - src-tauri/src/terminal/agent_manager.rs:3040
  - src-tauri/src/commands/agent.rs:182
  - src-tauri/src/commands/agent.rs:245
  - src-tauri/src/commands/agent.rs:289
  - src-tauri/src/session/remote_proxy.rs:371
  - src-tauri/src/session/manager.rs:1433
  - src-tauri/src/session/manager.rs:1770
  - src-tauri/src/terminal/agent_manager.rs:2443
  - src-tauri/src/terminal/agent_manager/io_task.rs:745
  - src-tauri/src/terminal/agent_manager.rs:1556
---

## What

`AgentConnectionManager::connect_agent` takes `self.agents.lock()` (a std::sync::Mutex holding every agent's connection) at :1005 and does not release it until `drop(agents)` at :1350. Everything in between happens under that lock: the `handle.block_on(...)` of the SSH TCP connect and auth, any keyboard-interactive prompt (auth.rs:66 deliberately leaves prompt time out of the connect timeout), and `channel_open_session`, `exec` and the `initialize` read loop. That read loop calls `read_handshake_line` (:3029-3040), a bare `channel.wait().await` with no timeout. Every other user of the map blocks for that whole time. The sync Tauri commands `disconnect_agent`, `prune_dead_agents` and `get_agent_capabilities` run on the main thread. `RemoteProxy::is_connected` (remote_proxy.rs:371) is called from `SessionManager::write_session` and `list_sessions` on tokio workers while they hold the app-wide sessions mutex. Also affected: `io_sender` / `send_session_input` and `send_request` for every other agent, the I/O task's `reap_agent` (async context, io_task.rs:745), and the redrive's `reconnect_retained_agent`.

## Why it matters

While agent B is connecting (a black-holed host for up to the 45 s connect timeout, a password prompt the user is still typing, or an agent that never answers `initialize`), keystrokes into any agent-backed tab block a tokio worker. Each blocked keystroke also holds the global session map, so local tabs freeze too. Clicking Disconnect or opening capabilities for agent A freezes the main thread, and with it the whole webview. The connect has no timeout while the prompt is up, and `cancel_connect_agent` is also a sync main-thread command, so a main-thread freeze during a prompt can leave the user unable to answer or cancel, which makes it a UI hang with no exit. It also serializes every agent's connect and redrive behind the slowest one. The first audit fixed this pattern agent-side (CONC-004) but missed the desktop agent map.

## Recommendation

Hold the lock only for the short check and evict step at the start, then release it. Do the connect and handshake with no lock held, keeping a 'connecting' reservation (the existing `connecting` registry) so a second connect for the same id gets `already_connected`. Re-acquire the lock only to insert the finished `AgentConnection` and its io_budget. Also wrap the post-auth handshake (channel open, exec, initialize read) in a `tokio::time::timeout`, e.g. the 45 s connect timeout, raced against the cancel token. Add a regression test: connect to a host that never answers `initialize`, and check that `is_connected`, `get_capabilities` and `disconnect_agent` for another agent return promptly.

## Verification

I confirmed this in the code. In `connect_agent`, `self.agents.lock()` is taken at agent_manager.rs:1005 and released only by `drop(agents)` at :1350. Between those two lines, `handle.block_on(run_connect_cancellable(...))` runs the whole SSH connect and auth, `channel_open_session`, `exec` and the `initialize` read loop.

- **No timeout on the handshake read.** `read_handshake_line` waits on a bare `channel.wait().await`. The only thing that can stop it is the cancel token raced in `run_connect_cancellable` (:840).
- **Prompt time is not counted.** `timeout_excluding_prompts` (auth.rs:66) deliberately leaves keyboard-interactive prompt time out of the 45 s connect timeout.
- **Other callers take the same std Mutex.** `is_connected` (:1421), `get_capabilities` (:1465), `disconnect_agent` (:1371) and `io_sender` (:2438) all lock the same map, so they block for the whole connect.
- **Main-thread commands.** In commands/agent.rs, `disconnect_agent`, `prune_dead_agents` and `get_agent_capabilities` are plain sync commands with no spawn_blocking, so in Tauri they run on the main thread. Only connect and shutdown are moved off it with spawn_blocking.
- **Keystrokes and session listing.** `RemoteProxy::is_connected` (remote_proxy.rs:371) locks the agents map whenever its own connected flag is true. `SessionManager::write_session` (manager.rs:1433) and `list_sessions` (:1770) call it while holding the sessions mutex.

**Mitigations I found:**

- `cancel_connect_agent` uses the separate `connecting` registry, so a cancel does not need the agents lock. The finding's "no exit" claim only holds if the main thread is already frozen by another sync command, such as Disconnect or capabilities on a different agent.
- A local tab only freezes indirectly, when a blocked agent-tab write is holding the sessions mutex.

**No deliberate decision.** I found nothing in architecture.md or audit/FINAL-SUMMARY.md that accepts this design. The CONC-009 comment at the eviction site only covers aborting a dead task.

**Severity: high.** Connecting to a slow or black-holed host is a common action. During it, every agent tab and any main-thread agent command can stall for up to 45 s, or with no limit while a prompt is open or an agent never answers `initialize`.
