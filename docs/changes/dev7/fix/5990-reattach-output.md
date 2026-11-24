### Fixed

- Agents: output printed while a tab re-opens a running persistent session, resumes
  its session after an agent disconnect, or moves to another window is no longer
  lost. The first command typed right after re-opening a session showed nothing
  (#5990).
- A tab that re-opens a session shows its scrollback once: no longer twice when the
  agent re-sends it late, after a Take over or Reclaim, or after the connection to
  the agent was re-established (#5990).
- A window that gets a session back writes output that arrived meanwhile before the
  line that ends the session (#5990).
