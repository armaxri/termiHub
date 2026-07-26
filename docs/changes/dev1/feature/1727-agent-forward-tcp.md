### Added

- SSH **agent forwarding now reaches the operator's own keys through a deployed
  agent over the TCP (`--listen`) transport** (#1727). #1719 delivered
  `forwardAgent` through a deployed agent using the agent-host-local ssh-agent,
  which only chains back to the operator when the desktop→agent leg is itself SSH
  with forwarding on. Over the TCP transport there is no such SSH leg. termiHub
  now relays the **desktop's** local ssh-agent to the session daemon over the
  desktop↔agent JSON-RPC transport: the daemon's SSH bridge sees a normal
  `$SSH_AUTH_SOCK`, and each forwarded ssh-agent connection is tunnelled back to
  the desktop's agent, so the operator's keys reach the final target regardless
  of how the desktop reached the agent. No local agent remains a graceful no-op.
  Relaying is unix-only for now; a Windows agent host keeps the #1719 host-local
  model. Adds the `agent.forward.{open,data,close}` protocol messages
  (remote-protocol 0.5.0).
