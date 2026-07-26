### Added

- SSH **agent forwarding over the TCP (`--listen`) transport now works through a
  Windows agent host too** (#2038, follow-up to #1727). #1727 relayed the
  desktop's ssh-agent to a deployed agent over the JSON-RPC transport but only on
  unix, because the daemon's core SSH bridge on Windows opened a _fixed_ OpenSSH
  named pipe and ignored any per-session override. The bridge now honors a
  dedicated `TERMIHUB_SSH_AGENT_PIPE` variable, so the agent worker can bind a
  per-session relay **named pipe** (`\\.\pipe\termihub-agent-forward-<session>`)
  and inject it into the daemon without shadowing a real local OpenSSH agent. A
  session routed through a Windows agent host with **Forward SSH agent** on now
  exposes the operator's desktop keys on the final target, matching the unix
  behaviour; no reachable agent stays a graceful no-op. No protocol change — the
  `agent.forward.*` messages (remote-protocol 0.5.0) are unchanged.
