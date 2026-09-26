### Changed

- **Network tools on a remote agent now stream live.** When ping, traceroute, port scan
  or ping sweep runs on an agent, results appear as they arrive instead of all at once.
  Large runs, such as a ping sweep of a /16, are no longer cut off after 60 seconds.
  **Stop** now stops the run on the agent and shows the partial results. A ping with no
  count now runs until you stop it, the same as on this computer. Older agents keep the
  previous behavior until they are updated.
