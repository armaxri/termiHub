---
id: AGT2-004
title: "agent.forward.connect (VNC/RDP over agent) relays bulk TCP through unbounded queues with no flow control"
angle: agent-protocol
severity: medium
category: reliability
is_workaround: false
subsystem: "agent/src/session/agent_forward.rs + agent transport notification queue"
evidence:
  - agent/src/session/agent_forward.rs:185-219
  - agent/src/session/agent_forward.rs:391-420
  - agent/src/session/agent_forward.rs:204
  - agent/src/io/transport.rs:23
  - src-tauri/src/terminal/agent_forward.rs:100-109
  - src-tauri/src/session/agent_port_forward.rs:369-371
status: fixed
resolution: "#4284 — agent.forward.connect streams are credit-windowed both ways (agent.forward.ack, protocol 0.28.0); a slow consumer slows the remote source"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

\#3241 reuses the ssh-agent relay's stream table to tunnel a desktop port forward for VNC/RDP sessions hosted under an agent. On the agent, `read_socket` reads the target socket in a tight loop and pushes each chunk as an `agent.forward.data` notification into the transport's `NotificationSender`, an `UnboundedSender` (io/transport.rs:23). Nothing limits how far reads can run ahead of what the SSH channel has written. Desktop→agent bytes go into an unbounded per-stream mpsc (agent_forward.rs:204). On the desktop, the channels stay unbounded under the TAURI-014 reasoning that ssh-agent traffic is bounded by request/response (src-tauri agent_forward.rs:100). That reasoning does not apply to a graphical stream; agent_port_forward.rs:369 copies the note anyway.

## Why it matters

An RDP server pushes graphics updates continuously, and VNC clients pipeline update requests. When the target link (LAN) is faster than the desktop↔agent SSH link (WAN), queued notifications build up in agent memory without limit. Because the same FIFO also carries `connection.output` for every terminal session on that agent, a busy remote desktop delays all terminal output behind it (head-of-line latency), and memory pressure can take down the agent worker that holds those sessions.

## Evidence

- `agent/src/session/agent_forward.rs:185-219`
- `agent/src/session/agent_forward.rs:391-420`
- `agent/src/session/agent_forward.rs:204`
- `agent/src/io/transport.rs:23`
- `src-tauri/src/terminal/agent_forward.rs:100-109`
- `src-tauri/src/session/agent_port_forward.rs:369-371`

## Recommendation

Add per-stream flow control to the agent.forward TCP streams, for example the same credit-window scheme as the plugin proxy (`STREAM_WINDOW` plus acks), or at least a bounded per-stream channel where `read_socket` awaits capacity before reading again. On the agent, send forward data through a bounded queue, or a separate lower-priority queue from terminal output, so bulk streams cannot starve sessions. Update the TAURI-014 comments, which no longer describe the traffic correctly.

## Verification

Confirmed. `read_socket` (agent_forward.rs:391-420) loops reading and calls `notify()` on the transport's tokio `UnboundedSender` (io/transport.rs:23) with no credit window or capacity await. `connect_tcp` (line 204) and the desktop channels (src-tauri agent_forward.rs:100-109, agent_port_forward.rs:369-371) are also unbounded. The TAURI-014 request/response rationale does not hold for VNC/RDP, yet agent_port_forward.rs copies it. Forward data shares one FIFO with terminal output, so a fast LAN target over a slow WAN link can grow agent memory without limit and delay terminal output. Medium is right for reliability.
