### Fixed

- Sidebars no longer break at narrow widths (#4709). Toolbar buttons (for
  example "New Workspace / Save Current / import / export") collapse to icon
  buttons with tooltips and then into a "…" overflow menu instead of being
  clipped or hidden. List names use the whole row (hover actions no longer
  reserve invisible space) and show the full name in a tooltip when truncated.
  The Schedules header keeps "Pause all" on one line and never clips its "+"
  button; the History headers, the Connections header, agent header buttons and
  HTTP monitor rows adapt the same way. The minimum sidebar width is now 200px.
