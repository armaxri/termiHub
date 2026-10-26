### Fixed

- termiHub now always starts on the Connections sidebar view. It previously
  reopened whichever sidebar view was active when the app was last closed
  (for example Network Tools or Workflows), or a collapsed sidebar (#5010).
- The Remote Agents section starts collapsed while there are no agents. It
  expands when the first agent is added, and an explicit expand or collapse is
  kept until the section gains its first agent or loses its last (#5010).
