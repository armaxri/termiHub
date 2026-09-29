### Added

- Scheduled runs with **Connect if not connected** now also connect
  agent-hosted targets, still without asking anything: the agent connects
  them with saved credentials, key files and trusted host keys only. A target
  that would need input (a one-time code, a new host key, a missing password
  or key passphrase) is skipped with its reason, and a target on an agent too
  old to connect unattended is skipped as "agent too old for unattended
  connect" (#3877).
