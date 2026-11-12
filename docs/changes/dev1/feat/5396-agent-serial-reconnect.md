### Added

- Serial connections hosted on a remote agent now reopen their port when a USB adapter on the
  agent host is unplugged and plugged back in. The agent keeps the session and reopens the port
  on its own host with the same rules as a local serial tab: only the configured adapter, and a
  renamed port followed only on a matching serial number. The tab shows the usual reconnect
  strip with the attempt, the countdown and the reason; Cancel stops the agent from retrying.
  Needs an updated agent (protocol 0.37.0); with an older agent the session ends on a drop as
  before (#5396).
