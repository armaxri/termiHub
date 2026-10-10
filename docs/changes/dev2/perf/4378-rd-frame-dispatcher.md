### Changed

- Remote desktop (VNC/RDP): bursts of screen updates now repaint once per
  display frame instead of once per update, and the view is no longer
  reallocated on every update, so busy desktops use less CPU. With several
  remote-desktop tabs open, each tab now only handles its own session's
  events (#4378).
