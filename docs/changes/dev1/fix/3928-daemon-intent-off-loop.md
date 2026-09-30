### Fixed

- Agent: a desktop recovering its sessions under heavy load could take a live
  session away from another desktop. The session daemon waited only 2 s for a
  connecting worker to say whether it was recovering or taking over, and read
  a worker that was slower than that as a takeover. It also stopped
  forwarding terminal output while it waited. The daemon now reads that
  intent without pausing the session and allows 5 s for it, so a slow recovery
  is refused as intended and the live session keeps flowing (#3928).
