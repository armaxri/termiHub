### Fixed

- Accessibility: readable informational text no longer uses the faint
  "disabled" colour (about 2:1 contrast). HTTP monitor status and age, log
  viewer counts, timestamps and targets, plugin versions, the plugin list
  section header, empty-state panel titles, settings search "no results" and
  footer, portable-mode file status and "not found" labels, the spawn picker
  row hints and the panel-zoom hint now use the muted or secondary text colour,
  which meets WCAG AA in the Dark and Light themes. The unfocused active-tab
  indicator also uses the muted colour. The disabled colour is now reserved for
  disabled controls and enforced by a style guard (#5165).
