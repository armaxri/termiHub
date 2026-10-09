### Fixed

- Themes: Solarized Light and light custom or plugin themes now get a light file
  editor. The editor theme follows the app theme's colour scheme instead of
  matching only the built-in Light theme by name (#4356).
- Themes: text on accent-coloured surfaces (primary buttons, checked checkboxes,
  active chips) stays readable with any accent. Custom and plugin themes now pick
  dark or light on-accent text by WCAG contrast against their accent, so a light
  accent such as yellow no longer gets white text (#4356).
- Themes: the network latency chart and monitoring sparklines recolour at once
  when the theme changes, instead of keeping the previous theme's line, axis and
  grid colours until reopened (#4356).
