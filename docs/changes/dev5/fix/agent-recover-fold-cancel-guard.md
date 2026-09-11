### Fixed

- Stopping an agent-hosted tab that is reconnecting now reliably wins the race
  against the agent recovering its transport. Previously, if the agent
  re-established the connection just as you hit Stop, the tab could silently flip
  back to Connected — losing your "stop trying" intent and re-adopting a session
  you asked to abandon. The tab now stays Disconnected and the recovered session
  is torn down (SM-002).
