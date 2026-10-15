### Changed

- Live SSH-tunnel traffic stats are now pushed to the UI as a small per-tunnel update each
  second instead of resending the whole tunnel list, lowering the cost of having many tunnels
  open (#4574).
