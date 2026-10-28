### Fixed

- With **Command Marks (Shell Hook)** on, a long prompt that wraps in a narrow pane (for
  example a long host name in a split pane) no longer leaves its first row behind above
  the next prompt in a new local or SSH shell. The rows the first prompt used, and
  anything below them, are erased before the next prompt is drawn, so no stale text
  stays on the screen (#5054).
