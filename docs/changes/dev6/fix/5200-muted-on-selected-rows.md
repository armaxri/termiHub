### Fixed

- Accessibility: muted hint text on hovered and selected list rows (spawn picker,
  plugin list, Open Connections, transfer queue, log viewer, monitoring menu,
  network monitors) now meets WCAG AA contrast in the Dark and Light themes. A new
  `--text-muted-on-selection` token is used in those row states; custom and plugin
  themes derive it automatically (#5200).
