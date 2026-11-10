### Fixed

- Accessibility: secondary text (meta lines, paths, counts, shortcuts) on hovered and
  selected list rows, menu items and command-palette entries now meets WCAG AA
  contrast in the Dark and Light themes. A new `--text-secondary-on-selection` token
  replaces `--text-secondary` inside those row states; custom and plugin themes
  derive it automatically (#5249).
