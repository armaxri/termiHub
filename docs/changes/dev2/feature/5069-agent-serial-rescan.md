### Added

- Serial: the Port field of a serial connection hosted on a remote agent now
  rescans the agent's serial ports while it is on screen, too, so an adapter
  plugged into or removed from the agent's machine appears or disappears within
  about two seconds, with the same "newly detected" and "not connected" hints
  as local ports. A slow or unreachable agent is asked less often instead of
  being flooded (#5069). Needs an agent with protocol 0.34.0 or newer; an older
  agent keeps showing the ports it found when it connected.
