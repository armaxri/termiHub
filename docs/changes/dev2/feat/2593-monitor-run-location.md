### Added

- System monitoring can now explicitly run on a connected agent, not just the
  desktop. A monitor's execution host is a first-class **Run on** choice on the
  Open Connections monitoring rows — This computer (the default, unchanged) or a
  connected agent — consistent with the network-tools and HTTP-monitor
  selectors. Choosing an agent routes the monitor's subscription through that
  agent's own host, so the streamed CPU/memory/disk samples come from the agent;
  changing the vantage reconnects the monitor on the newly chosen host. The
  desktop default is preserved, so existing monitors are unaffected (#2593, part
  of #2139).
