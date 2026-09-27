### Changed

- Network tools: every tool (ping, ping sweep, port scan, traceroute, DNS,
  Wake-on-LAN, open ports) now runs through one code path, on this computer
  and on a remote agent. Tools run on an agent always stream live and can be
  stopped. The agent protocol moves to 0.12.0 and drops its old per-tool
  `network.*` methods (#3731).
- Network tools on a remote agent now need agent protocol 0.9.0 or newer. An
  older agent shows a clear "update the agent to use network tools" message
  instead of failing; update the agent to use them there (#3731).

### Fixed

- Network tools: an error from starting a tool now shows its message instead of
  `[object Object]` (#3731).
