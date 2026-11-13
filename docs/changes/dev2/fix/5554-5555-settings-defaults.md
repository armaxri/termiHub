### Changed

- **X11 forwarding is now off by default** for new SSH connections, like
  OpenSSH's `ForwardX11 no`: forwarding lets the remote host open windows on
  your local X server and read what you type into them. Settings ▸ General ▸
  New connection defaults explains this. Profiles that already store the
  setting keep it, so an existing install that had it on stays on (#5555).

### Fixed

- An SSH session to a POSIX shell with the shell hook off no longer shows the
  typed `export DISPLAY=…` and `xauth` lines (or configured environment
  variables): that setup is now hidden the same way as the hooked setup, and
  kept out of the shell history (#5555).
- Numeric settings (Appearance ▸ Font size and Line height, Terminal ▸
  Scrollback buffer) no longer render as empty inputs: an unset value shows
  the effective default with a **Default** marker, and a set value gets a
  **Reset** button (#5554).
