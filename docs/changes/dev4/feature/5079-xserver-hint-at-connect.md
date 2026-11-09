### Added

- Opening an SSH connection with X11 forwarding now tells you at once when no
  usable local X server could be found, instead of only logging it. A toast
  ("X11 forwarding unavailable") shows the reason and the fix — e.g. on a
  Wayland-only Linux session it says to install your distribution's XWayland
  package — and its **Install XWayland…** / **Show details** action opens the
  X server setup error screen with the install and retry actions. The session
  still opens without forwarding (#5079).
