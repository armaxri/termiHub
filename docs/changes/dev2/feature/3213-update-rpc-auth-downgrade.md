### Security

- Remote-agent updates now need more than an initialized connection. The agent
  refuses `agent.request_update` / `agent.request_deferred_update` unless the
  request carries the agent instance's own update auth token, on top of the
  release signature (AGT-003). The token lives in an owner-only file on the agent
  host; the agent advertises only its path, and the desktop reads it over its SSH
  session just before it updates the agent. So a process that can reach the
  agent's RPC surface but cannot read the agent user's files cannot swap the
  agent binary.
- Agent downgrades are refused unless they are a **matched downgrade**: the
  desktop explicitly pins the pushed binary to its own version, and the version
  embedded in the signed binary equals that pin (SEC-006). The version is read
  from the binary itself, not from the request, so an old signed build cannot be
  passed off as a new one. Upgrades and same-version reinstalls are unchanged.
  The desktop's coordinated push pins its bundled agent to its own version, so
  putting back the agent that matches the desktop keeps working.
- Agent protocol 0.13.0. A desktop older than this can still use a 0.13.0 agent
  for everything except updating it.
