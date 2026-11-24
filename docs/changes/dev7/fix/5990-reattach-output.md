### Fixed

- Agents: output printed while a tab re-opens a running persistent session, resumes
  its session after an agent disconnect, or moves to another window is no longer
  lost. The first command typed right after re-opening a session showed nothing
  (#5990).
- A tab that re-opens a session no longer shows its scrollback twice when the agent
  re-sends it late (#5990).
