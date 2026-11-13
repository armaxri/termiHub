### Fixed

- UI: labels on status-tinted chips, badges and banners (agent version badge
  states, active log-level filters, Open Connections badges, plugin status,
  tab "spawned" badge, close-window pills, settings and password notices,
  file-editor and network-tool banners, the highlighted danger menu item and
  the reconnect strip's reason/error lines) no longer paint the status colour
  on a tint of itself, which measured down to ~3:1 in Light and Solarized.
  They use the primary text colour, at least 4.5:1 in every built-in theme; the
  tint, border and icon keep the status cue (#5740).
