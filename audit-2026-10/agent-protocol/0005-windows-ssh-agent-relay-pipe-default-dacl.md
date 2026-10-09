---
id: AGT2-005
title: "Windows ssh-agent relay pipe uses the default named-pipe DACL and no peer-SID check, unlike the other per-user endpoints"
angle: agent-protocol
severity: low
category: security
is_workaround: false
subsystem: "agent/src/session/agent_forward.rs (Windows)"
evidence:
  - agent/src/session/agent_forward.rs:256-262
  - agent/src/session/agent_forward.rs:347
  - agent/src/daemon/transport.rs:344-346
  - core/src/ipc/local_socket.rs:493-503
status: fixed
resolution: "#4322 — the Windows relay pipe binds via DaemonListener (CurrentUserOnly): per-user protected DACL on every instance plus peer-SID check"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

On Windows the per-session ssh-agent relay pipe `\\.\pipe\termihub-agent-forward-<session>` is created with a plain `ServerOptions::new().create(...)`, and so is each re-armed instance. That means no security attributes, so the system default DACL applies, which grants Everyone and Anonymous read access. Every other agent IPC endpoint goes through `core::ipc::local_socket` with `ListenerSecurity::CurrentUserOnly` (a current-user DACL plus an SID check at accept, the AGT-022 fix), including the session daemon pipe and the ki-prompt and connect-report relays.

## Why it matters

Another local user who learns or guesses the session id can open an instance of the relay pipe. The agent counts each connection as a new forwarded ssh-agent stream: it sends `agent.forward.open` to the desktop, which connects to the operator's real ssh-agent, and the instance is used up. With read-only access the intruder cannot submit sign requests, so the impact is limited to spurious streams and connections to the operator's agent, plus weaker defence in depth. The real issue is that this endpoint does not follow the per-user policy the project chose for every other local endpoint.

## Evidence

- `agent/src/session/agent_forward.rs:256-262`
- `agent/src/session/agent_forward.rs:347`
- `agent/src/daemon/transport.rs:344-346`
- `core/src/ipc/local_socket.rs:493-503`

## Recommendation

Bind the relay pipe through `termihub_core::ipc::local_socket` with `ListenerSecurity::CurrentUserOnly`, as the daemon and ki-prompt endpoints do, for both the first instance and each re-armed instance, so the DACL and accept-time SID check match. Add a Windows test like the AGT-022 one.

## Verification

Confirmed. Lines 260 and 347 call `ServerOptions::new().create(&pipe)` with no security attributes, whereas the daemon pipe uses `local_socket` with `ListenerSecurity::CurrentUserOnly` (current-user DACL + peer SID check, local_socket.rs:493-503). The default named-pipe DACL gives Everyone and Anonymous read access. Impact is limited (spurious streams, no sign requests), so low-severity defence-in-depth gap.
