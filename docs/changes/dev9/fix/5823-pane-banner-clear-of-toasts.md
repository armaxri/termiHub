### Fixed

- The "Agent disconnected" / "Session ended" banner in a terminal pane is no longer cut off at
  small window sizes, and a toast no longer covers its Reconnect button (#5823). The banner now
  sits at the top of the pane, like the reconnect strip, and reads a short "Agent
  disconnected. Press Enter to reconnect." that wraps instead of clipping. The toast stack keeps
  clear of it and of the reconnect strip, and the terminal search bar opens below either one.
