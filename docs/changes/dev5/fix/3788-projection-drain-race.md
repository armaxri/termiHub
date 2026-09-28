### Fixed

- Live UI state (transfer queue, system monitors, tunnels, agents, connections,
  settings) could get stuck showing an outdated value when two backend updates
  to the same area landed at nearly the same moment. For example, a closed
  system monitor could stay on screen, or a transfer row could keep an old
  progress value, until the app restarted. Each update now reads the state and
  applies it in one step, so the newest value always wins. Debug builds also
  resync on an internal consistency mismatch instead of dropping the update
  (#3788).
