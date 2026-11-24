### Fixed

- Agent: after you disconnect an agent and connect it again, an agent tab's
  Reconnect resumes the shell it showed instead of starting a second one beside
  it. Disconnect leaves the agent's sessions running, so "Active sessions" used
  to list two identical rows for one tab. The tab keeps its earlier output and
  adds a "— reconnected hh:mm:ss — session resumed —" line; when the session is
  gone it says "new remote shell; running programs were lost", as SSH does
  (#5953).
- Agent: sessions with the same name are numbered apart in "Active sessions"
  ("bash", "bash 2"), and the update strip counts and names the same sessions
  ("Waits for 2 sessions (bash, bash 2) to close.") instead of counting open
  tabs (#5953).
