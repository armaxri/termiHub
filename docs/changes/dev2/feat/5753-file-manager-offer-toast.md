### Changed

- File manager integration: the "Open in termiHub" offer is now a one-time toast
  with **Install** and **Not now** (closing it counts as Not now) instead of a bar
  docked at the bottom of the window. It is shown once, never in a session that
  shows the crash banner, and stays until answered; the install remains available
  in Settings › File manager integration. Profiles that chose "Don't show again"
  on the old bar are not offered it again (#5753).
