### Fixed

- Scrolling up while a command is still printing output now keeps your position.
  Previously a scroll that landed in the frame between an output chunk being
  written and the follow-up "stay at the bottom" step could be undone, snapping
  the view back to the bottom (most noticeable on macOS) (#4851).
