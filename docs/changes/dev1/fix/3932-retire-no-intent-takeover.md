### Fixed

- Agent: a connecting worker that never said whether it was recovering or
  taking over could still take a live session away from another desktop after
  5 s. The session daemon now refuses such a worker and leaves the session
  with the desktop that holds it. Only an explicit takeover, such as Reclaim,
  moves a session between desktops (#3932).
