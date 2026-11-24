### Changed

- Agents: the agent setup tab now says when the setup is over. A strip at the
  top of the tab reads "Agent installed" or "Agent setup failed" (with the
  reason), or "Agent setup cancelled", and offers Close tab; the install output
  stays readable below it. On a Linux or macOS host the setup ends the tab's
  shell, so the tab no longer stays open as a plain shell after the install. A
  Windows setup says its commands were sent and to check the output (#5865).
