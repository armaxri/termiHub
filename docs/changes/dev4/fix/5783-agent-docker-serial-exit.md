### Fixed

- A serial tab on a termiHub remote agent whose port does not come back now ends with
  "— device disconnected —" once the agent gives up reopening it, instead of staying open with a
  dead session. It is not reconnected. The same holds for a serial port lost on the agent with
  Auto-Reconnect off (#5783).
- A Docker tab, direct or on a remote agent, now ends when its shell exits or its container
  stops, instead of staying open. On an agent the tab shows the real exit status,
  "[Process exited with code N]", and is not reconnected. Needs an updated agent (protocol
  0.40.0); with an older agent the session behaves as before (#5783).
