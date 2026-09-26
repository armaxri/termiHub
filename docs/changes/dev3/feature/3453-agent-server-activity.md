### Added

- Embedded servers hosted on a remote agent now show their live access log and
  detailed statistics in the Services sidebar, the same as servers running on
  this computer. The same privacy rules apply: no passwords, `Authorization`
  headers or HTTP query strings are recorded. Clearing the log clears it on the
  agent. An older agent that cannot report the log is called out as "not
  supported by this agent version" instead of showing "No access log yet".
- Agent protocol 0.11.0 adds `embedded_server.activity` and
  `embedded_server.clear_activity`, advertised through the new
  `embeddedServerActivity` capability.
