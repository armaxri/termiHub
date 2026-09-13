---
id: ARCH-010
title: Agent session daemons are single-attach with silent takeover — a second desktop hijacks a live session's I/O
angle: architecture-overall
severity: medium
category: reliability
is_workaround: false
subsystem: agent/src/daemon
evidence:
  - agent/src/daemon/process.rs:194
  - docs/architecture.md:1425
status: open
---

## What

Each agent session runs as a detached daemon that exposes one Unix-socket /
named-pipe endpoint. The daemon is **single-attach with takeover**: on every new
`listener.accept()` it drops the current writer and aborts the current reader,
then installs the new connection as the sole attached worker
(`agent/src/daemon/process.rs:194-233` — `agent_writer = None;
abort_reader(&mut reader_task); … agent_writer = Some(write_half)`).

ADR-11's own correction documents the consequence: "single-attach with
takeover … a second connection **hijacks the live session's I/O**"
(`docs/architecture.md:1420-1429`). Sessions are shared across *time* (a
restarted worker re-attaches and replays the ring buffer), not across *workers*
(two live desktops cannot share a session; the second evicts the first).

## Why it matters

- **Silent cross-client I/O hijack.** If two desktop instances (multi-window is
  a first-class model per ADR-13, and the same agent can be reached from two
  machines) attach to the same persistent agent session, the second silently
  takes over the PTY and the first's reader is aborted with no user-visible
  signal at the session level. For a terminal driving real hardware/remote hosts,
  two operators unknowingly time-sharing one live session is a correctness and
  safety concern, not just a UX one.
- The multi-host coordination that would make this visible/consensual (ADR-11a's
  `--registry-daemon`) exists as substrate and is consumed only by the update
  broadcast (#1351); there is no "session N is already attached elsewhere"
  surfacing on the attach path itself.

## Evidence

- `agent/src/daemon/process.rs:194-233` — accept() evicts the incumbent
  (`agent_writer = None; abort_reader(...)`) before installing the new attach.
- `docs/architecture.md:1420-1429` (ADR-11 correction table) — "single-attach
  with takeover … a second connection hijacks the live session's I/O."

## Recommendation

Decide the intended multi-attach policy and make it explicit at the attach
boundary: either reject/queue a second attach with a clear "session in use
elsewhere" error surfaced to the UI, or promote takeover to a deliberate,
consented "steal session" action (like `tmux attach -d`). Use the existing
registry-daemon role to report cross-worker attach state so the takeover is
never silent. This should be settled before the persistent-agent feature leaves
experimental.
