### Added

- SSH tunnels: a tunnel that fails now shows as a red resting row in the tunnel
  sidebar with its persisted error message inline. The row offers **Retry**
  (restarts the tunnel and clears the stored error) and **View last error**
  (shows the full message) in place of the Play button, and the state survives a
  window reload. The errored tunnel also appears in the **Open Connections**
  panel with a working force-**Stop** so its leaked connection resources can be
  released (#1240).
