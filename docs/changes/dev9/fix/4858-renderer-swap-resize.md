### Fixed

- Switching tabs no longer resizes the terminals involved. Programs in a background tab (vim,
  htop, less) keep their layout instead of briefly re-flowing to a narrower width, and on Windows
  a keystroke typed right after switching tabs is no longer lost (#4858).
