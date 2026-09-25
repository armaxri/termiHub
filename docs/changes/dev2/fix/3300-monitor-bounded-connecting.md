### Fixed

- A system monitor can no longer stay in "Connecting" or "Reconnecting" forever
  (#3300). If no first sample arrives, it now shows "Offline" with Retry after a
  bounded number of collects. The same applies after a re-dial that connects but
  never produces a sample. This covers direct SSH, Docker/WSL, local, and
  agent-hosted monitors. The bound is 6 collects by default. That is more
  generous than the bound for unparseable output, so a slow first sample still
  goes live. An agent-hosted monitor that resolved to Offline recovers on its
  own if the agent starts streaming again.
